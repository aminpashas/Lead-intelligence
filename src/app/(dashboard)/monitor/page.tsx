import { Activity } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { decryptLeadPII } from '@/lib/encryption'
import { resolvePracticeTimeZone } from '@/lib/time/practice-timezone'
import { buildActivityFeed, type ActivitySource } from '@/lib/timeline/activity-feed'
import { ActivityMonitor } from '@/components/crm/activity-monitor'

export const metadata = {
  title: 'Monitor | Lead Intelligence',
}

// Per-source pulls. Each is newest-first; the merge keeps the most recent
// across all of them. Generous enough to fill a wall monitor without pulling
// the whole history on every refresh.
const MESSAGE_LIMIT = 150
const CALL_LIMIT = 80
const ACTIVITY_LIMIT = 60
const FEED_LIMIT = 160

/** Decrypted, display-ready name from a joined `leads` row (array or object). */
function leadDisplayName(joined: unknown): { id: string; name: string } {
  const raw = (Array.isArray(joined) ? joined[0] : joined) as Record<string, unknown> | null | undefined
  if (!raw) return { id: '', name: 'Unknown lead' }
  const lead = decryptLeadPII(raw)
  const first = (lead.first_name as string) || ''
  const last = (lead.last_name as string) || ''
  const name =
    `${first} ${last}`.trim() ||
    (lead.phone as string) ||
    (lead.email as string) ||
    'Unknown lead'
  return { id: (lead.id as string) || '', name }
}

/** Where an event's node should link. Prefer the owning conversation; fall back
 *  to the lead record when the row isn't tied to a thread. */
function hrefFor(conversationId: string | null, leadId: string): string {
  return conversationId ? `/conversations/${conversationId}` : `/leads/${leadId}`
}

const LEAD_JOIN = 'lead:leads(id, first_name, last_name, phone, email)'

export default async function MonitorPage() {
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)

  if (!orgId) {
    return <MonitorFrame orgId="" entries={[]} timeZone={undefined} />
  }

  const [messagesRes, callsRes, activitiesRes, convosRes] = await Promise.all([
    supabase
      .from('messages')
      .select(`id, created_at, channel, direction, body, subject, status, ai_generated, sender_type, sender_name, conversation_id, lead_id, ${LEAD_JOIN}`)
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .limit(MESSAGE_LIMIT),
    supabase
      .from('voice_calls')
      .select(`id, created_at, started_at, direction, outcome, duration_seconds, outcome_notes, transcript_summary, recording_url, status, conversation_id, lead_id, ${LEAD_JOIN}`)
      .eq('organization_id', orgId)
      .not('ended_at', 'is', null)
      .order('created_at', { ascending: false })
      .limit(CALL_LIMIT),
    supabase
      .from('lead_activities')
      .select(`id, created_at, activity_type, title, description, lead_id, ${LEAD_JOIN}`)
      .eq('organization_id', orgId)
      .in('activity_type', ['note_added', 'stage_changed'])
      .order('created_at', { ascending: false })
      .limit(ACTIVITY_LIMIT),
    // Fallback lead→conversation map so orphan calls/notes still link somewhere
    // useful. Most-recent conversation per lead wins (rows arrive newest-first).
    supabase
      .from('conversations')
      .select('id, lead_id, last_message_at')
      .eq('organization_id', orgId)
      .order('last_message_at', { ascending: false })
      .limit(500),
  ])

  const messages = (messagesRes.data ?? []) as Record<string, unknown>[]
  const calls = (callsRes.data ?? []) as Record<string, unknown>[]
  const activities = (activitiesRes.data ?? []) as Record<string, unknown>[]

  const leadConversation = new Map<string, string>()
  for (const c of (convosRes.data ?? []) as { id: string; lead_id: string }[]) {
    if (c.lead_id && !leadConversation.has(c.lead_id)) leadConversation.set(c.lead_id, c.id)
  }

  // Build the id→source index off the same rows the feed is built from.
  const sourceById = new Map<string, ActivitySource>()

  for (const m of messages) {
    const { id: joinedId, name } = leadDisplayName(m.lead)
    const leadId = (m.lead_id as string) || joinedId
    const conversationId = (m.conversation_id as string) ?? leadConversation.get(leadId) ?? null
    sourceById.set(m.id as string, { leadId, leadName: name, conversationId, href: hrefFor(conversationId, leadId) })
  }

  for (const c of calls) {
    const { id: joinedId, name } = leadDisplayName(c.lead)
    const leadId = (c.lead_id as string) || joinedId
    const conversationId = (c.conversation_id as string) ?? leadConversation.get(leadId) ?? null
    sourceById.set(c.id as string, { leadId, leadName: name, conversationId, href: hrefFor(conversationId, leadId) })
  }

  for (const a of activities) {
    const { id: joinedId, name } = leadDisplayName(a.lead)
    const leadId = (a.lead_id as string) || joinedId
    const conversationId = leadConversation.get(leadId) ?? null
    sourceById.set(a.id as string, { leadId, leadName: name, conversationId, href: hrefFor(conversationId, leadId) })
  }

  const entries = buildActivityFeed(
    // The extra joined columns are harmless — buildTimeline reads only the
    // Pick-typed fields off each row.
    { messages: messages as never, calls: calls as never, activities: activities as never },
    sourceById,
  ).slice(0, FEED_LIMIT)

  const timeZone = await resolvePracticeTimeZone(supabase, orgId)

  return <MonitorFrame orgId={orgId} entries={entries} timeZone={timeZone} />
}

function MonitorFrame({
  orgId,
  entries,
  timeZone,
}: {
  orgId: string
  entries: Awaited<ReturnType<typeof buildActivityFeed>>
  timeZone?: string
}) {
  return (
    <div className="mx-auto max-w-[760px] space-y-6">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <Activity className="h-5 w-5 text-aurea-primary" strokeWidth={1.75} />
          <h1 className="text-2xl font-bold text-aurea-ink">Activity monitor</h1>
        </div>
        <p className="text-sm text-aurea-ink-2">
          Every call, text, email, and note across the workspace — live. Click any
          event to open its conversation.
        </p>
      </div>

      <ActivityMonitor entries={entries} orgId={orgId} timeZone={timeZone} />
    </div>
  )
}
