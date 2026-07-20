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

/** Only an INBOUND social DM mints a lead — our own outbound reply must not. */
export function isNewSocialLead(n: NormalizedGhlMessage): boolean {
  return n.direction === 'inbound' && n.channel !== null && n.channel in SOCIAL_SOURCE
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
 * consented channel to be fast on, and LI cannot reply in Messenger (GHL owns
 * that inbox), so the staff alert IS the follow-up.
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
        tags: [normalized.channel as string],
        notes: normalized.body ? `First ${preset.source} message: ${normalized.body}` : null,
        consent: { source: `ghl_${normalized.channel}_dm` },
        utm_source: preset.utmSource,
      },
      { caller: opts.caller ?? `ghl-${normalized.channel}-dm`, armSpeedToLead: false },
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
            message: normalized.body || null,
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
