/**
 * Inbound social capture → LI lead.
 *
 * Driven by /api/bus/receive on `lead.captured`. A channel owner (Growth Studio
 * for demand-gen social; Patient Engagement / Dion Desk for the conversation
 * surface) received a DM from a new person and hands it to LI, the lead CRM
 * system of record, to become a scored lead with a staff alert.
 *
 * Flow:
 *   1. envelope.dionPracticeId → LI organizations.id
 *   2. ingestLead (dedups on external_ref = PSID / email / phone)
 *   3. score + notifyNewLead
 *
 * LI OWNS NONE OF THE CHANNEL. It never replies on Messenger/IG — that inbox
 * belongs to PE/Desk (ECOSYSTEM.md:133,135). This module only mints the lead.
 *
 * CONSENT: an inbound DM is consent to reply ON THAT CHANNEL, within Meta's 24h
 * window — never SMS/email/voice. We therefore leave those channels' consent
 * UNKNOWN (ingest never fabricates `false`), so no autopilot path can text or
 * call a Messenger lead until the re-permission flow earns it.
 *
 * Never throws for "not matched" (returns a status); DOES throw on a transient DB
 * failure so the receiver leaves the event unprocessed for the reprocess pass.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ingestLead, type IngestInput } from '@/lib/leads/ingest'
import type { LeadCapturedEvent, SocialCaptureChannel } from './dion/lead'

export type SocialLeadOutcome =
  | { status: 'created'; leadId: string }
  | { status: 'deduplicated'; leadId: string }
  | { status: 'no_practice' | 'org_not_found' }

/** Human-facing source label per channel — matched against lead_sources (ilike). */
const SOURCE_LABEL: Record<SocialCaptureChannel, string> = {
  messenger: 'Messenger',
  instagram: 'Instagram DM',
}

/** Organic-social attribution per channel. These are NOT paid — a DM to the page
 * is not an ad click, so utm_medium is 'social', never 'paid_social'. */
const UTM_SOURCE: Record<SocialCaptureChannel, string> = {
  messenger: 'facebook',
  instagram: 'instagram',
}

/**
 * Split a Meta display name into first/last. Meta usually gives only a display
 * name ("Barbara J. Haffner"); explicit first/last win when the producer sends
 * them.
 *
 * `leads.first_name` is NOT NULL, so an unknown name must be '' — never null.
 */
export function splitCapturedName(
  event: LeadCapturedEvent['data'],
): { firstName: string; lastName: string | null } {
  if (event.firstName?.trim()) {
    return { firstName: event.firstName.trim(), lastName: event.lastName?.trim() || null }
  }
  const display = event.displayName?.trim()
  if (!display) return { firstName: '', lastName: null }
  const parts = display.split(/\s+/)
  if (parts.length === 1) return { firstName: parts[0], lastName: null }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
}

/**
 * Map a capture event to LI's ingest shape. Pure — unit-testable without mocks.
 *
 * Dedup key is `externalRef` = PSID, because Meta gives no email/phone for a DM.
 * email/phone stay null unless the person volunteered them to the channel owner.
 */
export function buildSocialLeadIngest(
  organizationId: string,
  data: LeadCapturedEvent['data'],
): IngestInput {
  const { firstName, lastName } = splitCapturedName(data)
  return {
    organizationId,
    firstName,
    lastName,
    email: data.email ?? null,
    phoneRaw: data.phone ?? null,
    source: SOURCE_LABEL[data.channel],
    sourceType: data.channel,
    externalRef: `${data.channel}:${data.psid}`,
    tags: [data.channel, 'social_dm'],
    notes: data.firstMessageText?.trim() ? `First message: ${data.firstMessageText.trim()}` : null,
    utm_source: UTM_SOURCE[data.channel],
    // Consent: record only the channel they initiated on. sms/email deliberately
    // left undefined → UNKNOWN, never a fabricated false.
    consent: { source: `${data.channel}_inbound` },
  }
}

/**
 * Decide whether a social capture should arm LI's proactive first-touch outreach
 * (speed-to-lead).
 *
 * POLICY: arm only when the person volunteered a phone or email in the DM.
 *
 * Why this and not a consent test: this system's consent model is **opt-out
 * only** — imported/captured leads are treated as contactable and only an
 * explicit `*_opt_out` blocks a channel (see CLAUDE.md; `assertConsent`). So the
 * question here is not "may we contact them" — the send path already answers
 * that — it is "is there anywhere to send to at all".
 *
 *   • No phone/email (the common Messenger case — Meta gives only a PSID + name):
 *     arming speed-to-lead would queue outreach with no address to send it to.
 *     Staff still get the new-lead alert and reply in Messenger, which is PE/
 *     Desk's inbox, not LI's.
 *   • Phone/email volunteered in the DM ("call me at …"): that is a reachable
 *     channel and an explicit invitation, so normal speed-to-lead applies and the
 *     opt-out gate governs the send as it does for every other source.
 *
 * Meta's 24h reply window constrains the *Messenger* reply, which LI never
 * sends — that constraint lives with the inbox owner (ECOSYSTEM.md:133,135).
 *
 * To change the policy (e.g. suppress outreach for social entirely), this
 * function is the single switch — nothing else branches on it.
 */
export function shouldArmSpeedToLead(params: {
  channel: SocialCaptureChannel
  hasVolunteeredContact: boolean
}): boolean {
  return params.hasVolunteeredContact
}

/** Handle a `lead.captured` event end-to-end. */
export async function handleLeadCaptured(
  supabase: SupabaseClient,
  event: LeadCapturedEvent,
): Promise<SocialLeadOutcome> {
  const dionPracticeId = event.dionPracticeId
  if (!dionPracticeId) return { status: 'no_practice' }

  const { data: org } = await supabase
    .from('organizations')
    .select('id')
    .eq('dion_practice_id', dionPracticeId)
    .maybeSingle()
  if (!org) return { status: 'org_not_found' }

  const orgId = org.id as string
  const data = event.data

  const hasVolunteeredContact = Boolean(data.email || data.phone)
  const result = await ingestLead(supabase, buildSocialLeadIngest(orgId, data), {
    caller: `social-capture:${data.channel}`,
    armSpeedToLead: shouldArmSpeedToLead({ channel: data.channel, hasVolunteeredContact }),
  })

  if (result.deduplicated) return { status: 'deduplicated', leadId: result.id }

  // Organic-social attribution the shared ingest path doesn't carry.
  await supabase
    .from('leads')
    .update({
      utm_medium: 'social',
      custom_fields: { meta_psid: data.psid, meta_page_id: data.pageId, social_channel: data.channel },
    })
    .eq('id', result.id)

  await result.runPostIngest()

  // Score + staff alert. Best-effort: a scoring hiccup must not lose the lead.
  try {
    const { scoreLead } = await import('@/lib/ai/scoring')
    const { notifyNewLead } = await import('@/lib/notifications/new-lead-alert')
    const { data: lead } = await supabase.from('leads').select('*').eq('id', result.id).single()
    if (lead) {
      const score = await scoreLead(lead, supabase)
      await supabase
        .from('leads')
        .update({
          ai_score: score.total_score,
          ai_qualification: score.qualification,
          ai_score_breakdown: { dimensions: score.dimensions, confidence: score.confidence },
          ai_score_updated_at: new Date().toISOString(),
          ai_summary: score.summary,
        })
        .eq('id', result.id)

      const { firstName, lastName } = splitCapturedName(data)
      await notifyNewLead(supabase, {
        organizationId: orgId,
        // Identity from the event plaintext — the DB row is encrypted.
        lead: {
          id: result.id,
          firstName: firstName || 'Unknown',
          lastName,
          email: data.email ?? null,
          phone: data.phone ?? null,
          source: SOURCE_LABEL[data.channel],
          tags: [data.channel, 'social_dm'],
          utm_source: UTM_SOURCE[data.channel],
          utm_medium: 'social',
          aiQualification: score.qualification,
          aiScore: score.total_score,
          aiSummary: score.summary,
          submittedAt: data.firstMessageAt,
        },
        // The DM's real arrival time — suppresses alerts on backfilled replays.
        sourceCreatedAt: data.firstMessageAt,
      })
    }
  } catch {
    /* scoring + alert are best-effort — never lose an ingested lead over them */
  }

  return { status: 'created', leadId: result.id }
}
