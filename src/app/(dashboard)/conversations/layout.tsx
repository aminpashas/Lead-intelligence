import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptLeadPII } from '@/lib/encryption'
import { ConversationsSidebar, type ConversationListItem } from '@/components/crm/conversations-sidebar'
import { MessengerPanes } from '@/components/crm/messenger-panes'

/**
 * Messenger shell for the Conversations hub.
 *
 * This is a Next.js *layout*, so it persists across navigation into
 * `/conversations/[id]` — the inbox rail (and its filter/scroll state) never
 * remounts or refetches when you switch threads. The selected conversation is
 * a real, deep-linkable route rendered into the center pane (`children`).
 *
 * PII is decrypted here, server-side, once; the rail receives only a
 * render-ready, ciphertext-free projection.
 */
export default async function ConversationsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)

  let items: ConversationListItem[] = []

  if (orgId) {
    const { data: convoRows } = await supabase
      .from('conversations')
      .select(`
        id, channel, unread_count, last_message_at, last_message_preview,
        ai_enabled, ai_mode, sentiment, status,
        lead:leads(id, first_name, last_name, phone, email, ai_score, ai_qualification)
      `)
      .eq('organization_id', orgId)
      // Archived threads are resolved/put-away — keep them out of the live inbox
      // so a lead that was texted twice doesn't show a stale second SMS row.
      .neq('status', 'archived')
      .order('last_message_at', { ascending: false })
      .limit(300)

    items = (convoRows || []).map((c): ConversationListItem => {
      // The embedded `lead` join can type as an array under some Supabase
      // codegen — normalize to the single related row before decrypting.
      const joined = c.lead as unknown
      const rawLead = (Array.isArray(joined) ? joined[0] : joined) as
        | Record<string, unknown>
        | null
        | undefined
      const lead = rawLead ? (decryptLeadPII(rawLead) as Record<string, unknown>) : null
      const first = (lead?.first_name as string) || ''
      const last = (lead?.last_name as string) || ''
      const name = `${first} ${last}`.trim() || (lead?.phone as string) || (lead?.email as string) || 'Unknown lead'
      const initials =
        `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase() ||
        name.slice(0, 2).toUpperCase() ||
        '?'

      return {
        id: c.id as string,
        leadId: (lead?.id as string) ?? null,
        // Pass the channel through verbatim. This used to default to 'sms',
        // which quietly disguised any channel the UI didn't recognize as a text
        // thread; `channelMeta()` now handles unknown values explicitly.
        channel: c.channel as string,
        unread: (c.unread_count as number) ?? 0,
        lastAt: (c.last_message_at as string) ?? null,
        preview: (c.last_message_preview as string) ?? null,
        aiEnabled: Boolean(c.ai_enabled),
        aiMode: (c.ai_mode as string) ?? null,
        sentiment: (c.sentiment as string) ?? null,
        status: (c.status as string) ?? 'active',
        name,
        initials,
        phone: (lead?.phone as string) ?? null,
        email: (lead?.email as string) ?? null,
        score: (lead?.ai_score as number) ?? null,
        qualification: (lead?.ai_qualification as string) ?? null,
      }
    })
  }

  return (
    <MessengerPanes rail={<ConversationsSidebar conversations={items} />}>
      {children}
    </MessengerPanes>
  )
}
