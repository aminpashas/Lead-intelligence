/**
 * Mint an LI lead from an inbound Facebook/Instagram DM by a GHL contact we've
 * never seen, and fire the staff new-lead alert.
 *
 * Shared by BOTH ingest paths so they cannot drift:
 *   • the go-forward webhook  (src/app/api/webhooks/ghl/message)
 *   • the conversation sweep  (src/lib/ghl/backfill-conversations.ts)
 *
 * Why social is special: an inbound DM from a stranger IS the lead event. Meta
 * hands GHL a display name and nothing else — no phone, no email — so neither
 * the ghl_contact_id lookup nor the phone/email hash fallback can ever match,
 * and unlike SMS/email there is no later bridge that lands this person. Without
 * this, the thread is silently dropped and no alert ever fires.
 *
 * Deliberately narrow: ONLY inbound messenger/instagram. Applying the same
 * create-on-miss to sms/email would mint leads for the whole unmatched backlog.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getContact } from './client'
import type { GhlConfig } from './types'
import type { NormalizedGhlMessage } from './conversations'
import { ingestLead } from '@/lib/leads/ingest'
import type { IngestLead } from './ingest-message'
import { logger } from '@/lib/logger'

/** Per-channel presentation for a social DM lead. */
const SOCIAL_SOURCE: Record<string, { source: string; sourceType: string; utmSource: string }> = {
  messenger: { source: 'Messenger', sourceType: 'messenger', utmSource: 'facebook' },
  instagram: { source: 'Instagram DM', sourceType: 'instagram', utmSource: 'instagram' },
}

/** Any FB/IG message, either direction. */
export function isSocialMessage(n: NormalizedGhlMessage): boolean {
  return n.channel !== null && n.channel in SOCIAL_SOURCE
}

/**
 * The lead's opening message — or null when we don't have one.
 *
 * MUST check direction. The poller matches on `isSocialMessage`, which accepts
 * BOTH directions so outreach threads still create leads; on a thread the
 * practice spoke in first, `normalized.body` is therefore OUR text. Quoting it
 * as "First Messenger message" put the practice's own canned reply on the lead
 * record and into the staff alert, as if the patient had said it.
 */
export function firstInboundNote(
  sourceLabel: string,
  n: NormalizedGhlMessage,
): string | null {
  if (n.direction !== 'inbound' || !n.body) return null
  return `First ${sourceLabel} message: ${n.body}`
}

/**
 * Only an INBOUND social DM mints a lead *and alerts*.
 *
 * The webhook uses this: mid-thread it sees one message at a time and can't tell
 * an outreach thread from a reply, so it stays strict. The poller sees the whole
 * thread, so it uses `isSocialMessage` to capture outreach too and suppresses the
 * alert when nothing inbound is present.
 */
export function isNewSocialLead(n: NormalizedGhlMessage): boolean {
  return n.direction === 'inbound' && isSocialMessage(n)
}

export type SocialLeadOptions = {
  /** Suppress the staff alert (bulk re-sync of old threads). Lead is still created. */
  suppressAlert?: boolean
  /** Attribution for the audit/activity trail, e.g. 'ghl-messenger-dm'. */
  caller?: string
}

/**
 * Create the lead. Returns null when the contact can't be fetched or named, so
 * callers fall through to their normal "no lead → skip" behaviour.
 *
 * Consent for sms/email/voice is left UNKNOWN: messaging a social page is not
 * permission to text or call. Speed-to-lead is never armed — there is no
 * consented channel to be fast on.
 *
 * Staff CAN now reply in-channel from LI (the thread composer relays through
 * GHL via /api/social/send), so the alert points at a thread that can actually
 * be answered rather than being the whole follow-up on its own.
 */
export async function createLeadFromSocialDm(
  supabase: SupabaseClient,
  orgId: string,
  config: GhlConfig,
  contactId: string | null,
  normalized: NormalizedGhlMessage,
  opts: SocialLeadOptions = {},
): Promise<IngestLead | null> {
  if (!contactId) return null
  const preset = SOCIAL_SOURCE[normalized.channel as string]
  if (!preset) return null

  const contact = await getContact(config, contactId)
  if (!contact) return null

  // GHL splits the Meta display name inconsistently across revisions; fall back
  // to `name` and let ingestLead's guard strip anything phone-shaped.
  const first = contact.firstName?.trim() || contact.name?.trim().split(/\s+/)[0] || ''
  const last = contact.lastName?.trim() || contact.name?.trim().split(/\s+/).slice(1).join(' ') || null
  if (!first) return null

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
        // Lets the DGS bridge and the bus capture path resolve to this same
        // lead — GHL's contact id is the only id this path knows the person by.
        identities: [{ kind: 'ghl_contact_id', value: contactId }],
        tags: [normalized.channel as string],
        notes: firstInboundNote(preset.source, normalized),
        consent: { source: `ghl_${normalized.channel}_dm` },
        utm_source: preset.utmSource,
      },
      {
        caller: opts.caller ?? `ghl-${normalized.channel}-dm`,
        armSpeedToLead: false,
        // Meta gives no phone/email, and this path knows the person only by a
        // GHL contact id — which the DGS bridge never sends. Without the name
        // fallback the same person arriving down both paths duplicates.
        socialNameMatch: true,
      },
    )
  } catch (err) {
    logger.error('social DM lead creation failed', {
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
            utm_medium: 'social',
            // Same guard as the note: never quote our own outbound text to
            // staff as though the patient wrote it.
            message: normalized.direction === 'inbound' ? normalized.body || null : null,
          },
          // The DM's own timestamp — a replayed thread must not blast a stale alert.
          sourceCreatedAt: normalized.createdAt,
        })
      } catch {
        /* staff alert is best-effort — never blocks capture */
      }
    }
    // The sweep runs outside a request context (no `after`), so await directly;
    // the webhook wraps this call in `after` itself.
    await runAlert()
  }

  return { id: result.id, first_name: first, last_name: last }
}
