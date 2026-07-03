/**
 * /api/v1/leads — service-key authenticated bridge endpoint.
 *
 * Consumed by sibling Vercel projects (currently dion-growth-studio) that
 * don't have a user session. Uses the Supabase service role key to bypass
 * RLS, with the caller-supplied customer_id treated as the
 * organization_id (both are UUIDs and the partner systems map 1:1).
 *
 * GET  /api/v1/leads?customer_id=<uuid>&limit=<n>
 *   Returns { leads: LeadIntelLead[] } — schema matches the bridge's
 *   expected response shape in dion-growth-studio.
 *
 * POST /api/v1/leads
 *   Body: { customer_id, full_name, email?, phone?, source, notes?,
 *           utm_source?, utm_medium?, utm_campaign?, utm_term?, utm_content?,
 *           gclid?, fbclid?, landing_page_url?, referrer_url?,
 *           campaign_attribution?, external_ref?, sms_consent?, ... }
 *   Splits full_name into first_name/last_name, looks up source by name,
 *   encrypts PII, audits as HIPAA PHI write. Returns { id, lead_id }.
 *   Re-POSTing an existing lead (matched by external_ref, then contact hash)
 *   dedups AND merges any newly-resolved campaign attribution onto it — DGS
 *   uses this to back-sync campaigns that resolve after the initial push.
 */
import { NextRequest, NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { verifyServiceKey, isOrgAllowed } from '@/lib/auth/service-key'
import { encryptLeadPII, decryptLeadsPII, searchHash } from '@/lib/encryption'
import { auditPHIRead, auditPHIWrite } from '@/lib/hipaa-audit'
import { formatToE164 } from '@/lib/leads/phone'
import { safeParseBody } from '@/lib/body-size'
import { triggerSpeedToLead } from '@/lib/autopilot/speed-to-lead'
import { deriveConsentFields } from '@/lib/consent/ingest'
import { findExistingPatientByHash, markLeadAsExistingPatient } from '@/lib/ehr/patient-lookup'

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}
function asStr(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

// Whitelisted keys of the DGS-resolved campaign attribution blob. Anything
// else the caller sends is dropped so the jsonb column can't be used as a
// dumping ground by a compromised bridge key.
const CAMPAIGN_ATTR_KEYS = [
  'channel', 'campaign_id', 'campaign_name', 'ad_group_id', 'ad_group_name',
  'keyword_text', 'click_id_type', 'attribution_model', 'resolved_at', 'source_system',
] as const

function sanitizeCampaignAttribution(v: unknown): Record<string, string | number> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const raw = v as Record<string, unknown>
  const out: Record<string, string | number> = {}
  for (const k of CAMPAIGN_ATTR_KEYS) {
    const s = raw[k]
    if (typeof s === 'string' && s) out[k] = s.slice(0, 500)
  }
  const conf = raw.attribution_confidence
  if (typeof conf === 'number' && Number.isFinite(conf)) out.attribution_confidence = conf
  return Object.keys(out).length ? out : null
}

// Attribution columns consulted/patched on a dedup hit.
const ATTR_UTM_COLS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'landing_page_url', 'referrer_url',
] as const
type AttrUtmCol = (typeof ATTR_UTM_COLS)[number]

interface DedupRow extends Partial<Record<AttrUtmCol, string | null>> {
  id: string
  external_ref: string | null
  campaign_attribution: Record<string, unknown> | null
}

interface IncomingAttribution extends Partial<Record<AttrUtmCol, string | null>> {
  campaign_attribution: Record<string, string | number> | null
}

/**
 * Merge attribution onto an existing lead on a dedup hit. This is what makes
 * the DGS attribution back-sync work: the first push often lands BEFORE the
 * DGS resolver has matched a campaign (batch ingests resolve after pushing),
 * so DGS re-POSTs the same external_ref once resolved and the campaign blob
 * is merged here instead of creating a duplicate lead.
 *
 * Policy: campaign_attribution is replaced when the incoming confidence is >=
 * what we hold (attribution improves monotonically: 0.85 click-id-only → 1.0
 * once the campaign syncs); flat utm/click-id columns are backfilled only when
 * currently null. Returns true when anything was written.
 */
async function mergeAttributionOnDedup(
  supabase: ReturnType<typeof serviceRoleClient>,
  existing: DedupRow,
  incoming: IncomingAttribution,
): Promise<boolean> {
  const patch: Record<string, unknown> = {}
  const inc = incoming.campaign_attribution
  if (inc) {
    const curConf = Number(existing.campaign_attribution?.attribution_confidence ?? 0)
    const newConf = Number(inc.attribution_confidence ?? 0)
    const replaces = !existing.campaign_attribution || newConf >= curConf
    if (replaces && JSON.stringify(inc) !== JSON.stringify(existing.campaign_attribution)) {
      patch.campaign_attribution = inc
    }
  }
  for (const k of ATTR_UTM_COLS) {
    if (!existing[k] && incoming[k]) patch[k] = incoming[k]
  }
  if (Object.keys(patch).length === 0) return false
  const { error } = await supabase.from('leads').update(patch).eq('id', existing.id)
  return !error
}

const MAX_LIMIT = 200

function serviceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Supabase service role not configured')
  return createClient(url, key, { auth: { persistSession: false } })
}

function splitName(full: string): { first_name: string; last_name: string | null } {
  const trimmed = (full ?? '').trim()
  if (!trimmed) return { first_name: 'Unknown', last_name: null }
  const idx = trimmed.indexOf(' ')
  if (idx < 0) return { first_name: trimmed, last_name: null }
  return {
    first_name: trimmed.slice(0, idx),
    last_name: trimmed.slice(idx + 1).trim() || null,
  }
}

// GET /api/v1/leads?customer_id=<org-uuid>&limit=<n>
export async function GET(request: NextRequest) {
  const auth = verifyServiceKey(request)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const caller = auth.caller

  const { searchParams } = new URL(request.url)
  const customerId = searchParams.get('customer_id')
  if (!customerId) {
    return NextResponse.json({ error: 'customer_id is required' }, { status: 400 })
  }
  // Multi-tenant guard: a caller may only touch its allowlisted orgs.
  if (!isOrgAllowed(auth, customerId)) {
    return NextResponse.json({ error: 'forbidden_org' }, { status: 403 })
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(searchParams.get('limit') ?? '50') || 50))

  const supabase = serviceRoleClient()
  const { data, error } = await supabase
    .from('leads')
    .select('id, organization_id, first_name, last_name, email, phone, status, source_type, utm_source, lead_source:lead_sources(name), created_at, last_contacted_at')
    .eq('organization_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const decrypted = decryptLeadsPII(data ?? [])
  const leads = decrypted.map((l: Record<string, unknown>) => ({
    id: String(l.id),
    customer_id: String(l.organization_id),
    full_name: [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || null,
    email: (l.email as string) ?? null,
    phone: (l.phone as string) ?? null,
    status: String(l.status ?? 'new'),
    source:
      ((l.lead_source as { name?: string } | null)?.name) ??
      (l.source_type as string) ??
      (l.utm_source as string) ??
      null,
    created_at: String(l.created_at),
    last_contacted_at: (l.last_contacted_at as string) ?? null,
  }))

  if (leads.length > 0) {
    await auditPHIRead(
      { supabase, organizationId: customerId, actorType: 'system', actorId: caller },
      'lead',
      `bridge:${caller}:${leads.length}`,
      `Service-key read of ${leads.length} leads by ${caller}`,
    )
  }

  return NextResponse.json({ leads })
}

// POST /api/v1/leads — create a lead via service key
export async function POST(request: NextRequest) {
  const auth = verifyServiceKey(request)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const caller = auth.caller

  const { data: body, error: bodyError } = await safeParseBody(request)
  if (bodyError) return bodyError

  const customerId = (body as Record<string, unknown>)?.customer_id
  const fullName = (body as Record<string, unknown>)?.full_name
  if (typeof customerId !== 'string' || !customerId) {
    return NextResponse.json({ error: 'customer_id is required' }, { status: 400 })
  }
  // Multi-tenant guard — before any DB query.
  if (!isOrgAllowed(auth, customerId)) {
    return NextResponse.json({ error: 'forbidden_org' }, { status: 403 })
  }
  if (typeof fullName !== 'string' || !fullName.trim()) {
    return NextResponse.json({ error: 'full_name is required' }, { status: 400 })
  }

  const { first_name, last_name } = splitName(fullName)
  const email = typeof (body as Record<string, unknown>)?.email === 'string'
    ? ((body as Record<string, string>).email || null)
    : null
  const phoneRaw = typeof (body as Record<string, unknown>)?.phone === 'string'
    ? (body as Record<string, string>).phone
    : ''
  const phoneFormatted = phoneRaw ? formatToE164(phoneRaw) : null
  const sourceName = typeof (body as Record<string, unknown>)?.source === 'string'
    ? (body as Record<string, string>).source
    : null
  const notes = typeof (body as Record<string, unknown>)?.notes === 'string'
    ? (body as Record<string, string>).notes
    : null

  // Consent + attribution carried by the DGS bridge (all optional, additive).
  // Consent drives whether the autopilot may ever text/call/email this lead.
  // Tri-state: a field set to true is an explicit opt-in; false is an explicit
  // decline; OMITTED means "no signal" → status 'unknown' (eligible for the
  // consent-capture flow). We never fabricate a `false` boolean from a missing
  // field — that was the bug that made every bridged lead look like it declined.
  const b = body as Record<string, unknown>
  const consentFields = deriveConsentFields({
    sms_consent: asBool(b?.sms_consent),
    email_consent: asBool(b?.email_consent),
    voice_consent: asBool(b?.voice_consent),
    consent_source: asStr(b?.consent_source),
  })
  const utm_source = asStr(b?.utm_source)
  const gclid = asStr(b?.gclid)
  const fbclid = asStr(b?.fbclid)
  const utm_medium = asStr(b?.utm_medium)
  const utm_campaign = asStr(b?.utm_campaign)
  const utm_term = asStr(b?.utm_term)
  const utm_content = asStr(b?.utm_content)
  const landing_page_url = asStr(b?.landing_page_url) ?? asStr(b?.landing_page)
  const referrer_url = asStr(b?.referrer_url) ?? asStr(b?.referrer)
  // Exact campaign-level attribution resolved by DGS (channel + campaign_id/
  // campaign_name + ad group + keyword + confidence). Stored as jsonb.
  const campaignAttribution = sanitizeCampaignAttribution(b?.campaign_attribution)
  const incomingAttribution: IncomingAttribution = {
    campaign_attribution: campaignAttribution,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content,
    gclid, fbclid, landing_page_url, referrer_url,
  }
  // Explicit DGS correlation id — preferred over regexing it out of notes for the
  // conversion writeback trigger. Accept either spelling.
  const external_ref = asStr(b?.external_ref) ?? asStr(b?.dgs_lead_id)
  // Cross-system correlation id (DGS inbound_leads.id). Stored in its own
  // indexed column so the writeback trigger can match without notes-regex.
  const externalRef = asStr(b?.external_ref)

  const supabase = serviceRoleClient()

  // Idempotency: dedup by contact hash within the org so re-scanning sources
  // (e.g. the WhatConverts bulk sync, which re-pulls a 90-day window on every
  // run) return the existing lead instead of creating duplicates. Returning
  // early here also means speed-to-lead does NOT re-fire on an already-known
  // lead. Consent is intentionally left untouched on a dedup hit (never
  // downgraded). searchHash is HMAC-SHA256 hex → safe in a PostgREST or-filter.
  const emailHash = email ? searchHash(email) : null
  const phoneHash = (phoneFormatted || phoneRaw) ? searchHash(phoneFormatted || phoneRaw) : null
  const DEDUP_COLS =
    'id, external_ref, campaign_attribution, ' + ATTR_UTM_COLS.join(', ')

  // Dedup pass 0: exact correlation id. A re-POST with the same external_ref
  // is an update-intent call (DGS re-syncs attribution after its resolver
  // runs), so match it BEFORE the contact hash — it targets the exact lead
  // even if the contact details were edited in LI since.
  let existing: DedupRow | null = null
  if (externalRef) {
    const { data } = await supabase
      .from('leads')
      .select(DEDUP_COLS)
      .eq('organization_id', customerId)
      .eq('external_ref', externalRef)
      .limit(1)
      .maybeSingle()
    existing = (data as DedupRow | null) ?? null
  }
  if (!existing && (emailHash || phoneHash)) {
    const orFilter = [
      emailHash ? `email_hash.eq.${emailHash}` : null,
      phoneHash ? `phone_hash.eq.${phoneHash}` : null,
    ].filter(Boolean).join(',')
    const { data } = await supabase
      .from('leads')
      .select(DEDUP_COLS)
      .eq('organization_id', customerId)
      .or(orFilter)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    existing = (data as DedupRow | null) ?? null
  }
  if (existing) {
    // Backfill external_ref only when missing — never overwrite an existing
    // correlation id (the first DGS submit owns it).
    if (externalRef && !existing.external_ref) {
      await supabase
        .from('leads')
        .update({ external_ref: externalRef })
        .eq('id', existing.id)
        .is('external_ref', null)
    }
    const attribution_updated = await mergeAttributionOnDedup(supabase, existing, incomingAttribution)
    return NextResponse.json(
      {
        id: existing.id,
        lead_id: existing.id,
        deduplicated: true,
        ...(attribution_updated ? { attribution_updated: true } : {}),
      },
      { status: 200 },
    )
  }

  // Look up source_id by name (or null if not found) — keeps the call
  // idempotent without forcing the caller to know LI's internal source IDs.
  let source_id: string | null = null
  if (sourceName) {
    const { data: src } = await supabase
      .from('lead_sources')
      .select('id')
      .eq('organization_id', customerId)
      .ilike('name', sourceName)
      .maybeSingle()
    source_id = src?.id ?? null
  }

  // Default pipeline stage for the org.
  const { data: defaultStage } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('organization_id', customerId)
    .eq('is_default', true)
    .maybeSingle()

  const insertData = encryptLeadPII({
    organization_id: customerId,
    first_name,
    last_name,
    email,
    phone: phoneRaw || null,
    phone_formatted: phoneFormatted ?? undefined,
    stage_id: defaultStage?.id,
    source_id,
    notes,
    source_type: sourceName,
    ...(externalRef ? { external_ref: externalRef } : {}),
    ...consentFields,
    ...(utm_source ? { utm_source } : {}),
    ...(utm_medium ? { utm_medium } : {}),
    ...(utm_campaign ? { utm_campaign } : {}),
    ...(utm_term ? { utm_term } : {}),
    ...(utm_content ? { utm_content } : {}),
    ...(gclid ? { gclid } : {}),
    ...(fbclid ? { fbclid } : {}),
    ...(landing_page_url ? { landing_page_url } : {}),
    ...(referrer_url ? { referrer_url } : {}),
    ...(campaignAttribution ? { campaign_attribution: campaignAttribution } : {}),
    ...(external_ref ? { external_ref } : {}),
  })

  const { data: lead, error } = await supabase
    .from('leads')
    .insert(insertData)
    .select('id')
    .single()

  if (error || !lead) {
    // Concurrent ingest race: a unique (org,email_hash) index rejected the loser.
    // Return the existing lead as a dedup hit instead of a 500.
    if (error?.code === '23505' && emailHash) {
      const { data: dupe } = await supabase
        .from('leads')
        .select('id')
        .eq('organization_id', customerId)
        .eq('email_hash', emailHash)
        .limit(1)
        .maybeSingle()
      if (dupe) {
        return NextResponse.json({ id: dupe.id, lead_id: dupe.id, deduplicated: true }, { status: 200 })
      }
    }
    return NextResponse.json({ error: error?.message ?? 'Insert failed' }, { status: 500 })
  }

  await supabase.from('lead_activities').insert({
    organization_id: customerId,
    lead_id: lead.id,
    activity_type: 'created',
    title: `Lead created via ${caller}`,
    description: `${first_name} ${last_name ?? ''}`.trim() + ` added by service bridge`,
  })

  await auditPHIWrite(
    { supabase, organizationId: customerId, actorType: 'system', actorId: caller },
    'lead',
    String(lead.id),
    `Service-key lead creation by ${caller}`,
  )

  // Arm proactive AI first-touch. triggerSpeedToLead self-gates on
  // autopilot_enabled (org default FALSE), TCPA quiet-hours, agent capacity,
  // and per-lead sms/email consent — so this sends NOTHING until the org's
  // autopilot is switched on (post-Twilio approval). Runs after the response
  // so the bridge call never blocks on the LLM/first-message generation.
  after(async () => {
    // Soft financial pre-qualification from any free-text the source carried.
    // The DGS/GHL bridge pushes the contact's form message as `notes`, so we run
    // the regex-only qualifier over it (NO LLM cost — safe even on bulk
    // backfills) and persist a REAL tier + readiness. Without this, every
    // bridged lead keeps the `leads.financial_qualification_tier` column DEFAULT
    // ('tier_c'), which is indistinguishable from a genuine assessment. Writing
    // `financial_signals` (with its `last_updated` stamp) is what lets the UI
    // tell "assessed, no signal yet" apart from "never assessed".
    if (notes && notes.trim()) {
      try {
        const { extractFinancialSignals, mergeFinancialSignals, determineQualificationTier } =
          await import('@/lib/ai/financial-qualifier')
        const signals = mergeFinancialSignals(null, extractFinancialSignals(notes))
        const tier = determineQualificationTier(signals, {})
        const update: Record<string, unknown> = {
          financial_signals: signals,
          financial_qualification_tier: tier,
          financial_qualification_status: 'assessed',
          financing_readiness_score: signals.readiness_score,
        }
        if (signals.budget_monthly) update.preferred_monthly_budget = signals.budget_monthly
        if (signals.has_hsa_fsa !== null) update.has_hsa_fsa = signals.has_hsa_fsa
        if (signals.down_payment_mentioned) update.estimated_down_payment = signals.down_payment_mentioned
        await supabase.from('leads').update(update).eq('id', String(lead.id))
      } catch {
        // Non-fatal: financial qualification must never affect ingestion.
      }
    }

    // Existing-patient reconciliation: an inbound contact that already exists
    // as a synced EHR patient is NOT a net-new sales lead (e.g. an existing
    // patient calling a WhatConverts tracked number). Flag it — this drops the
    // lead out of the new-lead smart lists and short-circuits speed-to-lead
    // below. Runs before triggerSpeedToLead so the flag is set first.
    try {
      const match = await findExistingPatientByHash(supabase, customerId, { emailHash, phoneHash })
      if (match) {
        await markLeadAsExistingPatient(supabase, String(lead.id), customerId, match.patientId)
      }
    } catch {
      // Non-fatal: reconciliation must never affect ingestion.
    }

    try {
      await triggerSpeedToLead(supabase, String(lead.id), customerId)
    } catch {
      // Best-effort: a speed-to-lead failure must never affect ingestion.
    }
  })

  return NextResponse.json({ id: lead.id, lead_id: lead.id }, { status: 201 })
}
