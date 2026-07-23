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
import {
  resolveLeadByIdentity,
  recordLeadIdentities,
  type LeadIdentity,
} from '@/lib/leads/identities'
import { scrubPhoneNames, NAME_UNKNOWN_TAG } from '@/lib/leads/phone-name'
import { reconcileStoredName } from '@/lib/leads/recover-name'
import { findExistingPatientByHash, hasVisitBefore } from '@/lib/ehr/patient-lookup'
import { leadDisplayName } from '@/lib/leads/display-name'
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
  /**
   * Alternate correlation ids (Meta PSID, GHL contact id, DGS lead id). Matched
   * BEFORE the email/phone hash pass and recorded on create — this is the only
   * dedup signal that exists for a social DM, which carries neither a phone nor
   * an email. See lib/leads/identities.ts.
   */
  identities?: LeadIdentity[]
}

export type IngestOptions = {
  /** Audit actor / activity attribution, e.g. 'ghl-sync'. */
  caller: string
  /** Arm proactive first-touch outreach. Off for cold/bulk imports. */
  armSpeedToLead?: boolean
  /**
   * Enable the display-name fallback match (social DMs only).
   *
   * OFF by default and must stay off for the general lead firehose: name
   * collisions across 48k+ leads are common. Only social capture has both the
   * need (no phone/email to dedup on) and the safety margin — see
   * lib/leads/social-name-match.ts for the policy.
   */
  socialNameMatch?: boolean
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
  ctx: {
    sourceId: string | null
    stageId: string | null
    now?: string
    /** CareStack patient this contact matched, when they're an existing patient. */
    matchedPatientId?: string | null
  },
): Record<string, unknown> {
  const phoneRaw = input.phoneRaw?.trim() || null
  const phoneFormatted = input.phoneFormatted ?? (phoneRaw ? formatToE164(phoneRaw) : null)
  const email = input.email?.trim() || null

  // Upstream stores a contact's phone as its `name` when it has no name, and
  // every caller splits that on whitespace — so the phone lands in the name
  // columns and we greet a patient "Hi (925),". Drop the number rather than the
  // lead: a nameless lead is still a real prospect, and `leadDisplayName` falls
  // back to the phone. See phone-name.ts.
  const { first: firstName, last: lastName, changed: nameScrubbed } = scrubPhoneNames({
    first: input.firstName,
    last: input.lastName,
  })
  const tags = nameScrubbed && !(input.tags ?? []).includes(NAME_UNKNOWN_TAG)
    ? [...(input.tags ?? []), NAME_UNKNOWN_TAG]
    : input.tags

  const consentFields = deriveConsentFields({
    sms_consent: input.consent?.sms,
    email_consent: input.consent?.email,
    voice_consent: input.consent?.voice,
    consent_source: input.consent?.source ?? null,
    now: ctx.now,
  })

  return {
    organization_id: input.organizationId,
    // `first_name` is NOT NULL in the schema — '' is how it spells "no name".
    first_name: firstName ?? '',
    last_name: lastName,
    email,
    phone: phoneRaw,
    ...(phoneFormatted ? { phone_formatted: phoneFormatted } : {}),
    ...(ctx.stageId ? { stage_id: ctx.stageId } : {}),
    source_id: ctx.sourceId ?? null,
    notes: input.notes ?? null,
    source_type: input.sourceType ?? input.source ?? null,
    ...(ctx.matchedPatientId
      ? { is_existing_patient: true, matched_patient_id: ctx.matchedPatientId }
      : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(tags && tags.length ? { tags } : {}),
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

  // Idempotency, strongest signal first. A hit returns the existing lead (never
  // downgrading its consent) and backfills external_ref only when it has none.
  const identities = input.identities ?? []

  // Pass 1 — correlation id. An exact PSID / GHL-contact / DGS-lead match is
  // stronger evidence than a hash match, and for a social DM it is the ONLY
  // signal there is: Meta supplies a display name and a PSID, so `email` and
  // `phone` are both null and pass 2 can never fire. Without this, every DM
  // from a known person minted a duplicate.
  // Track HOW we matched: a correlation-id or contact-hash hit is proof of the
  // same person; the display-name pass is a fuzzy guess. Only the strong hits
  // earn the right to overwrite the stored name (see the refresh below).
  let matchedBy: 'identity' | 'hash' | 'name' | null = null
  let existingId = await resolveLeadByIdentity(supabase, input.organizationId, identities)
  if (existingId) matchedBy = 'identity'

  // Pass 2 — contact hash.
  if (!existingId) {
    const matches = await findExistingLeads(supabase, input.organizationId, [
      { email, phone_formatted: phoneFormatted },
    ])
    existingId = matches.get(0)?.id ?? null
    if (existingId) matchedBy = 'hash'
  }

  // Pass 3 — display name. The weakest signal by far, so it is opt-in, runs
  // last, and refuses far more than it accepts. It exists because the DGS
  // bridge and the GHL mirror share NO id namespace, so identity resolution
  // cannot link the same person arriving down both paths.
  if (!existingId && opts.socialNameMatch) {
    const { findNameMatchCandidates, pickNameMatch, normalizeName } = await import(
      '@/lib/leads/social-name-match'
    )
    const candidates = await findNameMatchCandidates(
      supabase,
      input.organizationId,
      input.firstName,
      input.lastName ?? null,
    )
    existingId = pickNameMatch(normalizeName(input.firstName, input.lastName ?? null), candidates)
    if (existingId) matchedBy = 'name'
  }

  if (existingId) {
    if (input.externalRef) {
      await supabase
        .from('leads')
        .update({ external_ref: input.externalRef })
        .eq('id', existingId)
        .is('external_ref', null)
    }
    // Repair a stale name from an earlier capture. The same person can arrive as
    // a second upstream contact whose name is spelled correctly ("vrrna"→"Verna")
    // — only trust it on a strong-signal match, and let `reconcileStoredName`
    // refuse anything phone/placeholder-shaped so we never re-break a good name.
    if (matchedBy === 'identity' || matchedBy === 'hash') {
      const { data: current } = await supabase
        .from('leads')
        .select('first_name, last_name')
        .eq('id', existingId)
        .maybeSingle()
      if (current) {
        const rename = reconcileStoredName(
          { first: current.first_name, last: current.last_name },
          { source: opts.caller, first: input.firstName, last: input.lastName ?? null },
        )
        if (rename) {
          await supabase.from('leads').update(rename).eq('id', existingId)
        }
      }
    }
    // Attach any ids this event carried that the lead didn't already have, so a
    // later event arriving on a DIFFERENT id still resolves to this same lead.
    // This is what actually collapses the three ingest paths onto one record.
    await recordLeadIdentities(supabase, input.organizationId, existingId, identities)
    return { id: existingId, deduplicated: true, runPostIngest: async () => {} }
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

  // Existing-patient parking, BEFORE the stage falls back to the default.
  //
  // WHY HERE: this check used to live inline in api/v1/leads only, so the four
  // other capture paths that funnel through this helper (GHL inbound SMS/email,
  // GHL social DM, Meta Lead Ads, Google Ads) minted existing patients straight
  // into the sales funnel. Putting it in the shared helper makes the guarantee
  // structural instead of per-route. Deterministic hash match against the
  // CareStack mirror — no heuristics, so it never mis-parks a real prospect.
  //
  // Off-funnel takes precedence over an explicit `stageId`: an existing patient
  // belongs to the front desk regardless of what the caller intended.
  let patientMatch: Awaited<ReturnType<typeof findExistingPatientByHash>> = null
  try {
    patientMatch = await findExistingPatientByHash(supabase, input.organizationId, {
      emailHash: email ? searchHash(email) : null,
      phoneHash: phoneFormatted ? searchHash(phoneFormatted) : null,
    })
  } catch {
    // Non-fatal: reconciliation must never block capture — fall through.
  }

  // Only an ESTABLISHED patient (one with a visit predating this enquiry) is
  // parked. A bare mirror match is not enough: CareStack creates the patient
  // record at BOOKING, so a prospect who books through LI would otherwise be
  // re-classified as an existing patient on their very next touch. The flag is
  // still set on any match — it is harmless and it blocks campaign enrolment —
  // but the lead stays in the funnel for a human to work.
  const isEstablishedPatient = patientMatch
    ? await hasVisitBefore(supabase, patientMatch.patientId, now).catch(() => false)
    : false

  // Explicit stage wins; otherwise fall back to the org's default stage.
  let stageId = input.stageId ?? null
  if (isEstablishedPatient) {
    const { data: parkingStage } = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('organization_id', input.organizationId)
      .eq('slug', 'existing-patient')
      .maybeSingle()
    // No parking stage for this org (migration not run) → leave the stage alone
    // and let the flag alone carry the signal.
    stageId = parkingStage?.id ?? stageId
  }
  if (!stageId) {
    const { data: defaultStage } = await supabase
      .from('pipeline_stages')
      .select('id')
      .eq('organization_id', input.organizationId)
      .eq('is_default', true)
      .maybeSingle()
    stageId = defaultStage?.id ?? null
  }

  const plainRow = buildLeadInsert(input, {
    sourceId,
    stageId,
    now,
    matchedPatientId: patientMatch?.patientId ?? null,
  })
  const insertData = encryptLeadPII(plainRow)

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

  // Register the correlation ids so the next event on any of them dedups here.
  await recordLeadIdentities(supabase, input.organizationId, leadId, identities)

  await supabase.from('lead_activities').insert({
    organization_id: input.organizationId,
    lead_id: leadId,
    activity_type: 'created',
    title: `Lead created via ${opts.caller}`,
    // Read back off the built row, not `input` — a phone parsed into the name
    // columns is scrubbed by then, and the activity feed should agree with the
    // lead rather than preserving the number we just rejected.
    description: leadDisplayName({
      first_name: plainRow.first_name as string | null,
      last_name: plainRow.last_name as string | null,
      phone_formatted: plainRow.phone_formatted as string | null,
    }),
  })

  await auditPHIWrite(
    { supabase, organizationId: input.organizationId, actorType: 'system', actorId: opts.caller },
    'lead',
    leadId,
    `Lead creation by ${opts.caller}`,
  )

  const runPostIngest = async () => {
    // Link the patient bridge for ANY mirror match — cheap, and it's what lets
    // the lead detail view show the EHR record.
    if (patientMatch) {
      try {
        const { markLeadAsExistingPatient } = await import('@/lib/ehr/patient-lookup')
        await markLeadAsExistingPatient(
          supabase,
          leadId,
          input.organizationId,
          patientMatch.patientId,
        )
      } catch {
        // Best-effort: the flag is already on the inserted row.
      }
    }

    // An ESTABLISHED patient is not a sales lead: hand off to the front desk and
    // skip financial qualification + speed-to-lead entirely (same policy
    // api/v1/leads applies). A merely-registered match falls through and is
    // processed as a normal lead — it is still flagged, so campaign enrolment
    // declines it, but a human can work it.
    if (isEstablishedPatient && patientMatch) {
      try {
        const { enqueueDeskExistingPatientContact } = await import('@/lib/bridges/dion-desk')
        await enqueueDeskExistingPatientContact(supabase, {
          organizationId: input.organizationId,
          leadId,
          patientId: patientMatch.patientId,
          matchMethod: patientMatch.matchMethod,
          sourceType: input.sourceType ?? input.source ?? null,
          channel: opts.socialNameMatch ? 'social_dm' : 'inbound_message',
        })
      } catch {
        // Best-effort: the hourly rematch cron re-enqueues a dropped hand-off.
      }
      return
    }

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

      // Enroll in the org's no-answer follow-up cadence (no-op unless the
      // sequence is enabled; the cron is additionally env-gated).
      try {
        const { enrollLeadInFollowUp } = await import('@/lib/automation/sequences')
        await enrollLeadInFollowUp(supabase, leadId, input.organizationId)
      } catch {
        // Best-effort: enrollment failure must never affect ingestion.
      }
    }
  }

  return { id: leadId, deduplicated: false, runPostIngest }
}
