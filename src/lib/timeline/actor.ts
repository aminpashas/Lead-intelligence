import type { TimelineEntry } from './types'

/**
 * Who performed a timeline event — the team member or AI agent behind an
 * outbound call/text, so a feed can say *by whom* rather than just *what*.
 *
 * `kind` drives the badge icon/tone: `ai` for automated agents, `staff` for a
 * human team member, `system` for platform-generated activity (e.g. call
 * analysis notes). Inbound events (the lead speaking) have no actor — the lead
 * *is* the subject, not an operator — so they resolve to `null`.
 */
export type TimelineActorKind = 'ai' | 'staff' | 'system'
export interface TimelineActor {
  name: string
  kind: TimelineActorKind
}

/** Title-cased AI persona label, e.g. `setter` → "AI Setter". */
function aiAgentLabel(agentType: string | null): string {
  if (!agentType || agentType === 'none') return 'AI Agent'
  return `AI ${agentType.charAt(0).toUpperCase()}${agentType.slice(1)}`
}

/**
 * Resolve the operator behind an entry, or `null` when there isn't one to show
 * (inbound messages/calls, notes, stage changes). Pure — staff names come from
 * the optional `userNameById` map the caller already fetched; when a name is
 * missing it degrades to a generic "Team member" rather than an opaque id.
 */
export function entryActor(
  entry: TimelineEntry,
  userNameById?: Map<string, string>,
): TimelineActor | null {
  if (entry.kind === 'message') {
    // Inbound is the lead themselves — no operator to attribute.
    if (entry.direction === 'inbound' || entry.senderType === 'lead') return null
    if (entry.senderType === 'ai' || entry.aiGenerated) {
      return { name: entry.senderName || 'AI Agent', kind: 'ai' }
    }
    if (entry.senderType === 'system') {
      return { name: entry.senderName || 'System', kind: 'system' }
    }
    return { name: entry.senderName || 'Team member', kind: 'staff' }
  }

  if (entry.kind === 'call') {
    // A human placed it via the browser softphone / bridge.
    if (entry.staffUserId) {
      return { name: userNameById?.get(entry.staffUserId) || 'Team member', kind: 'staff' }
    }
    // Otherwise it's AI-driven (outbound dialer or the inbound receptionist).
    if (entry.callMode === 'ai' || (entry.agentType && entry.agentType !== 'none')) {
      return { name: aiAgentLabel(entry.agentType), kind: 'ai' }
    }
    return null
  }

  return null
}
