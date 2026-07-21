/**
 * Mint an LI lead from an INBOUND SMS / email / call / WhatsApp / web-chat by a
 * GHL contact LI has never seen, and fire the staff new-lead alert.
 *
 * WHY THIS EXISTS: the poller's `resolveContactLead` is lookup-only, and until
 * now ONLY the social path created-on-miss. So a brand-new lead who *texts* the
 * practice — with no prior form fill that the DGS bridge landed in LI — had
 * their whole conversation dropped by the poller, and the watermark advanced
 * past it, making them invisible to LI forever. The message showed in GHL and
 * nowhere else. See poll-conversations.ts (the `!lead` branch).
 *
 * Only an INBOUND message mints a lead. An outbound-only thread to a non-lead is
 * the practice's own outreach (e.g. the GHL nurture blast), not a capture event.
 *
 * Distinct from social-lead.ts by design:
 *   • We HAVE a phone/email here, so dedup runs on the email/phone hash and the
 *     display-name fallback (`socialNameMatch`) is neither needed nor safe —
 *     name collisions across 48k+ leads are common.
 *   • Consent stays UNKNOWN. An inbound text is a reply opportunity for a human
 *     (that's what the alert is for), not a grant to arm automated outbound.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getContact } from './client'
import type { GhlConfig } from './types'
import type { NormalizedGhlMessage } from './conversations'
import { ingestLead } from '@/lib/leads/ingest'
import type { IngestLead } from './ingest-message'
import { firstInboundNote } from './social-lead'
import { logger } from '@/lib/logger'

/** Per-channel presentation for a non-social inbound lead. Social lives in social-lead.ts. */
const INBOUND_SOURCE: Record<
  string,
  { source: string; sourceType: string; utmSource: string; utmMedium: string }
> = {
  sms: { source: 'Inbound SMS', sourceType: 'sms', utmSource: 'sms', utmMedium: 'sms' },
  email: { source: 'Inbound Email', sourceType: 'email', utmSource: 'email', utmMedium: 'email' },
  call: { source: 'Inbound Call', sourceType: 'inbound_call', utmSource: 'phone', utmMedium: 'call' },
  whatsapp: { source: 'WhatsApp', sourceType: 'whatsapp', utmSource: 'whatsapp', utmMedium: 'whatsapp' },
  web_chat: { source: 'Web Chat', sourceType: 'web_chat', utmSource: 'web_chat', utmMedium: 'chat' },
}

/**
 * An inbound message on a channel that should mint a lead on first contact.
 *
 * Deliberately excludes social (messenger/instagram) — those carry no phone or
 * email and go through `createLeadFromSocialDm` instead. Outbound is excluded:
 * only the patient reaching out first is a capture event.
 */
export function isInboundCaptureMessage(n: NormalizedGhlMessage): boolean {
  return n.direction === 'inbound' && n.channel !== null && n.channel in INBOUND_SOURCE
}

export type InboundLeadOptions = {
  /** Suppress the staff alert (bulk re-sync of old threads). Lead is still created. */
  suppressAlert?: boolean
  /** Attribution for the audit/activity trail, e.g. 'ghl-poll-inbound'. */
  caller?: string
}

/**
 * Create the lead from a first inbound SMS/email/call. Returns null when the
 * contact can't be fetched or the channel isn't a capture channel, so callers
 * fall through to their normal "no lead → skip" behaviour.
 *
 * Unlike the social path, a MISSING name is fine: we have the phone/email, and
 * `ingestLead` stores a nameless lead ('' first_name) — still a real prospect,
 * with `leadDisplayName` falling back to the phone. Speed-to-lead is not armed:
 * consent is unknown, so there is no consented channel to be fast on; the staff
 * alert is the fast path.
 */
export async function createLeadFromInboundMessage(
  supabase: SupabaseClient,
  orgId: string,
  config: GhlConfig,
  contactId: string | null,
  normalized: NormalizedGhlMessage,
  opts: InboundLeadOptions = {},
): Promise<IngestLead | null> {
  if (!contactId) return null
  const preset = INBOUND_SOURCE[normalized.channel as string]
  if (!preset) return null

  const contact = await getContact(config, contactId)
  if (!contact) return null

  const first = contact.firstName?.trim() || contact.name?.trim().split(/\s+/)[0] || ''
  const last = contact.lastName?.trim() || contact.name?.trim().split(/\s+/).slice(1).join(' ') || null

  let result
  try {
    result = await ingestLead(
      supabase,
      {
        organizationId: orgId,
        firstName: first,
        lastName: last,
        email: contact.email?.trim() || null,
        phoneRaw: contact.phone?.trim() || null,
        source: preset.source,
        sourceType: preset.sourceType,
        externalRef: contactId,
        // Lets the DGS bridge and later syncs resolve to this same lead — GHL's
        // contact id is the strongest id this path knows the person by.
        identities: [{ kind: 'ghl_contact_id', value: contactId }],
        tags: [normalized.channel as string],
        notes: firstInboundNote(preset.source, normalized),
        consent: { source: `ghl_${normalized.channel}_inbound` },
        utm_source: preset.utmSource,
      },
      {
        caller: opts.caller ?? `ghl-${normalized.channel}-inbound`,
        armSpeedToLead: false,
        // We have a phone/email — dedup on hash. The name fallback is unsafe at
        // this scale and unnecessary here.
        socialNameMatch: false,
      },
    )
  } catch (err) {
    logger.error('inbound GHL lead creation failed', {
      orgId,
      contactId,
      channel: normalized.channel,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  await supabase.from('leads').update({ ghl_contact_id: contactId }).eq('id', result.id)

  if (!result.deduplicated) {
    const runAlert = async () => {
      await result.runPostIngest()
      if (opts.suppressAlert) return
      try {
        const { notifyNewLead } = await import('@/lib/notifications/new-lead-alert')
        await notifyNewLead(supabase, {
          organizationId: orgId,
          lead: {
            id: result.id,
            firstName: first,
            lastName: last,
            source: preset.source,
            tags: [normalized.channel as string],
            utm_source: preset.utmSource,
            utm_medium: preset.utmMedium,
            // Inbound by construction (isInboundCaptureMessage), so this is the
            // patient's own words — safe to surface to staff.
            message: normalized.body || null,
          },
          // The message's own timestamp — a replayed thread must not blast a stale alert.
          sourceCreatedAt: normalized.createdAt,
        })
      } catch {
        /* staff alert is best-effort — never blocks capture */
      }
    }
    // The poller runs outside a request context (no `after`), so await directly.
    await runAlert()
  }

  return { id: result.id, first_name: first, last_name: last }
}
