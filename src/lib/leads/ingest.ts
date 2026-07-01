/**
 * Shared single-lead ingest.
 *
 * Encapsulates the proven create-or-dedup path used by inbound lead sources:
 * dedup by email/phone hash, source-name lookup, default-stage assignment,
 * PII encryption, the `created` activity, the HIPAA audit write, and the
 * deferred financial-qualification / speed-to-lead arming.
 *
 * The GHL sync uses this so synced leads behave exactly like bridge-ingested
 * ones — crucially with consent left UNKNOWN (never a fabricated `false`) so
 * nothing is auto-contacted until the re-permission flow earns consent.
 *
 * Post-ingest work (financial regex + optional speed-to-lead) is returned as a
 * `runPostIngest` thunk so the caller decides whether to `await` it (cron) or
 * schedule it with `after()` (request handlers).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptLeadPII, searchHash } from '@/lib/encryption'
import { deriveConsentFields } from '@/lib/consent/ingest'
import { formatToE164 } from '@/lib/leads/phone'
import { findExistingLeads } from '@/lib/leads/dedupe'
import { auditPHIWrite } from '@/lib/hipaa-audit'

export type IngestConsentInput = {
  sms?: boolean
  email?: boolean
  voice?: boolean
  /** e.g. 'ghl_import'. Only stamped on channels explicitly granted (true). */
  source?: string | null
}

export type IngestInput = {
  organizationId: string
  firstName: string
  lastName?: string | null
  email?: string | null
  phoneRaw?: string | null
  phoneFormatted?: string | null
  /** Human source name — looked up against lead_sources (ilike). */
  source?: string | null
  sourceType?: string | null
  notes?: string | null
  externalRef?: string | null
  tags?: string[]
  status?: string | null
  /** Explicit pipeline stage; when absent the org's default stage is used. */
  stageId?: string | null
  consent?: IngestConsentInput
  utm_source?: string | null
  gclid?: string | null
  fbclid?: string | null
}

export type IngestOptions = {
  /** Audit actor / activity attribution, e.g. 'ghl-sync'. */
  caller: string
  /** Arm proactive first-touch outreach. Off for cold/bulk imports. */
  armSpeedToLead?: boolean
}

export type IngestResult = {
  id: string
  deduplicated: boolean
  /** Deferred best-effort post-processing. No-op on a dedup hit. */
  runPostIngest: () => Promise<void>
}

/**
 * Build the plaintext lead row (pre-encryption). Pure — no I/O — so the
 * consent/stage/external_ref/UTM shaping is unit-testable without mocks.
 */
export function buildLeadInsert(
  input: IngestInput,
  ctx: { sourceId: string | null; stageId: string | null; now?: string },
): Record<string, unknown> {
  const phoneRaw = input.phoneRaw?.trim() || null
  const phoneFormatted = input.phoneFormatted ?? (phoneRaw ? formatToE164(phoneRaw) : null)
  const email = input.email?.trim() || null

  const consentFields = deriveConsentFields({
    sms_consent: input.consent?.sms,
    email_consent: input.consent?.email,
    voice_consent: input.consent?.voice,
    consent_source: input.consent?.source ?? null,
    now: ctx.now,
  })

  return {
    organization_id: input.organizationId,
    first_name: input.firstName,
    last_name: input.lastName ?? null,
    email,
    phone: phoneRaw,
    ...(phoneFormatted ? { phone_formatted: phoneFormatted } : {}),
    ...(ctx.stageId ? { stage_id: ctx.stageId } : {}),
    source_id: ctx.sourceId ?? null,
    notes: input.notes ?? null,
    source_type: input.sourceType ?? input.source ?? null,
    ...(input.status ? { status: input.status } : {}),
    ...(input.tags && input.tags.length ? { tags: input.tags } : {}),
    ...(input.externalRef ? { external_ref: input.externalRef } : {}),
    ...consentFields,
    ...(input.utm_source ? { utm_source: input.utm_source } : {}),
    ...(input.gclid ? { gclid: input.gclid } : {}),
    ...(input.fbclid ? { fbclid: input.fbclid } : {}),
  }
}

export async function ingestLead(
  supabase: SupabaseClient,
  input: IngestInput,
  opts: IngestOptions,
): Promise<IngestResult> {
  const now = new Date().toISOString()
  const email = input.email?.trim() || null
  const phoneRaw = input.phoneRaw?.trim() || null
  const phoneFormatted = input.phoneFormatted ?? (phoneRaw ? formatToE164(phoneRaw) : null)

  // Idempotency: dedup by email/phone hash within the org. A hit returns the
  // existing lead (never downgrading its consent) and backfills external_ref
  // only when the existing row has none.
  const matches = await findExistingLeads(supabase, input.organizationId, [
    { email, phone_formatted: phoneFormatted },
  ])
  const existing = matches.get(0)
  if (existing) {
    if (input.externalRef) {
      await supabase
        .from('leads')
        .update({ external_ref: input.externalRef })
        .eq('id', existing.id)
        .is('external_ref', null)
    }
    return { id: existing.id, deduplicated: true, runPostIngest: async () => {} }
  }

  // Source name → id (idempotent; null when the source isn't pre-seeded).
  let sourceId: string | null = null
  if (input.source) {
    const { data: src } = await supabase
      .from('lead_sources')
      .select('id')
      .eq('organization_id', input.organizationId)
      .ilike('name', input.source)
      .maybeSingle()
    sourceId = src?.id ?? null
  }

  // Explicit stage wins; otherwise fall back to the org's default stage.
  let stageId = input.stageId ?? null
  if (!stageId) {
    const { data: defaultStage } = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('organization_id', input.organizationId)
      .eq('is_default', true)
      .maybeSingle()
    stageId = defaultStage?.id ?? null
  }

  const insertData = encryptLeadPII(buildLeadInsert(input, { sourceId, stageId, now }))

  const { data: lead, error } = await supabase
    .from('leads')
    .insert(insertData)
    .select('id')
    .single()

  if (error || !lead) {
    // Concurrent ingest race: a unique (org,email_hash) index rejected the loser.
    if (error?.code === '23505' && email) {
      const emailHash = searchHash(email)
      if (emailHash) {
        const { data: dupe } = await supabase
          .from('leads')
          .select('id')
          .eq('organization_id', input.organizationId)
          .eq('email_hash', emailHash)
          .limit(1)
          .maybeSingle()
        if (dupe) return { id: String(dupe.id), deduplicated: true, runPostIngest: async () => {} }
      }
    }
    throw new Error(error?.message ?? 'Lead insert failed')
  }

  const leadId = String(lead.id)

  await supabase.from('lead_activities').insert({
    organization_id: input.organizationId,
    lead_id: leadId,
    activity_type: 'created',
    title: `Lead created via ${opts.caller}`,
    description: `${input.firstName} ${input.lastName ?? ''}`.trim(),
  })

  await auditPHIWrite(
    { supabase, organizationId: input.organizationId, actorType: 'system', actorId: opts.caller },
    'lead',
    leadId,
    `Lead creation by ${opts.caller}`,
  )

  const runPostIngest = async () => {
    // Cheap regex-only financial pre-qualification from any free-text note.
    if (input.notes && input.notes.trim()) {
      try {
        const { extractFinancialSignals, mergeFinancialSignals, determineQualificationTier } =
          await import('@/lib/ai/financial-qualifier')
        const signals = mergeFinancialSignals(null, extractFinancialSignals(input.notes))
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
        await supabase.from('leads').update(update).eq('id', leadId)
      } catch {
        // Non-fatal: financial qualification must never affect ingestion.
      }
    }

    if (opts.armSpeedToLead) {
      try {
        const { triggerSpeedToLead } = await import('@/lib/autopilot/speed-to-lead')
        await triggerSpeedToLead(supabase, leadId, input.organizationId)
      } catch {
        // Best-effort: a speed-to-lead failure must never affect ingestion.
      }
    }
  }

  return { id: leadId, deduplicated: false, runPostIngest }
}
