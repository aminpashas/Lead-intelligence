/**
 * Task → AI delegation
 *
 * A human working the /tasks queue can hand a task to the AI ("let the AI do
 * it"). The AI generates the reply, the human reviews the EXACT outbound text,
 * and on confirm the AI sends it. The task then closes as `delegated_to_ai` —
 * distinct from the clock-driven `taken_by_ai` SLA takeover, so the AI-vs-Human
 * scoreboard can tell a deliberate hand-off from an automatic one.
 *
 * Two phases, both server-authoritative:
 *   preview  — generate a draft via processAutoResponse({ dryRun }) (every gate
 *              runs, nothing is sent, no rows are written to the patient's
 *              record) and STORE it on the task so commit can send that exact
 *              text. Returns 'ready' + the message, or 'blocked' + a reason.
 *   commit   — re-verify the task is still live and the thread hasn't been
 *              answered since, then send the STORED draft through the same
 *              consent-gated delivery path the autopilot uses, close the task,
 *              and record an audit event attributing the delegation to the human.
 *
 * v1 covers REPLY-shaped tasks only (an existing conversation the AI can answer):
 * inbound_reply, follow_up, sla_breach_review. Outreach, voice, and read-only
 * AI work are out of scope here.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptField } from '@/lib/encryption'
import { recordAudit } from '@/lib/audit/record'
import { logger } from '@/lib/logger'
import type { AgentType } from '@/lib/ai/agent-types'

/** Task kinds the AI can act on in v1 — a reply on an existing conversation. */
const REPLY_KINDS: ReadonlySet<string> = new Set([
  'inbound_reply',
  'follow_up',
  'sla_breach_review',
])

/** The live statuses a task must be in to be delegable / committable. */
const LIVE_STATUSES = ['open', 'claimed'] as const

/** Minimal shape the capability check needs — a subset of a human_tasks row. */
export type DelegableTask = {
  id: string
  kind: string
  status: string
  lead_id: string | null
  conversation_id: string | null
}

export type TaskAiCapability =
  | { capable: true; kind: 'reply'; label: string }
  | { capable: false }

/**
 * Can the AI act on this task, and how? Pure + cheap (no I/O) so it can annotate
 * every row in a task-list response. v1: reply-shaped kinds that still have a
 * live status and a conversation + lead to reply on.
 */
export function taskAiCapability(task: DelegableTask): TaskAiCapability {
  if (!LIVE_STATUSES.includes(task.status as (typeof LIVE_STATUSES)[number])) {
    return { capable: false }
  }
  if (!task.conversation_id || !task.lead_id) return { capable: false }
  if (!REPLY_KINDS.has(task.kind)) return { capable: false }
  return { capable: true, kind: 'reply', label: 'AI can draft & send this reply' }
}

// ── Preview ──────────────────────────────────────────────────────────

export type DelegationPreview =
  | {
      status: 'ready'
      message: string
      channel: 'sms' | 'email'
      confidence?: number
      agent?: string
    }
  | { status: 'blocked'; reason: string; draft?: string }
  | { status: 'error'; reason: string }

/** Stored on human_tasks.metadata.ai_delegation when a preview is 'ready'. */
type StoredDelegationDraft = {
  draft: string
  channel: 'sms' | 'email'
  agent: string
  confidence?: number
}

/**
 * Generate a reviewable AI draft for a reply-shaped task WITHOUT sending or
 * mutating the patient record. Persists the draft on the task so commit can send
 * the exact reviewed text. Returns why it can't when a gate blocks.
 */
export async function previewDelegation(
  supabase: SupabaseClient,
  orgId: string,
  task: DelegableTask
): Promise<DelegationPreview> {
  const cap = taskAiCapability(task)
  if (!cap.capable) return { status: 'blocked', reason: 'not_delegable' }

  // Load the full lead + conversation the reply is grounded in.
  const [{ data: lead }, { data: conversation }] = await Promise.all([
    supabase.from('leads').select('*').eq('id', task.lead_id!).eq('organization_id', orgId).maybeSingle(),
    supabase.from('conversations').select('*').eq('id', task.conversation_id!).eq('organization_id', orgId).maybeSingle(),
  ])
  if (!lead || !conversation) return { status: 'blocked', reason: 'lead_or_conversation_missing' }

  const ctx = await resolveReplyContext(supabase, task, lead, conversation)
  if (!ctx) return { status: 'blocked', reason: 'no_reply_context' }

  try {
    const { processAutoResponse } = await import('@/lib/autopilot/auto-respond')
    const result = await processAutoResponse(
      supabase,
      {
        organization_id: orgId,
        conversation_id: task.conversation_id!,
        lead_id: task.lead_id!,
        lead: lead as Record<string, unknown>,
        conversation: conversation as Record<string, unknown>,
        inbound_message: ctx.inboundMessage,
        channel: ctx.channel,
        sender_contact: ctx.senderContact,
      },
      { dryRun: true }
    )

    if (result.action === 'preview' && result.message) {
      const stored: StoredDelegationDraft = {
        draft: result.message,
        channel: ctx.channel,
        agent: result.agent ?? 'setter',
        confidence: result.confidence,
      }
      await persistDraft(supabase, orgId, task.id, stored)
      return {
        status: 'ready',
        message: result.message,
        channel: ctx.channel,
        confidence: result.confidence,
        agent: result.agent,
      }
    }

    // Any non-preview action means the AI is NOT clear to send (medical
    // question, low confidence, quiet hours, opt-out, shadow/assist mode…). The
    // reason is truthful; the draft (if any) is returned for context only.
    return { status: 'blocked', reason: result.reason ?? result.action, draft: result.message }
  } catch (err) {
    logger.warn('Delegation preview failed', {
      task_id: task.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return { status: 'error', reason: 'preview_failed' }
  }
}

// ── Commit ───────────────────────────────────────────────────────────

export type DelegationCommit =
  | { ok: true; message: string; channel: 'sms' | 'email' }
  | { ok: false; status: number; reason: string }

/**
 * Send the previewed AI draft and close the task as `delegated_to_ai`.
 *
 * Sends the STORED draft (the exact text the human reviewed), not a
 * client-supplied string, and re-checks that the task is still live and the
 * thread hasn't been answered since the preview — so a delegation can't fire
 * twice or step on a reply a teammate just sent. Delivery goes through the same
 * consent/opt-out/allowlist gates as the autopilot.
 */
export async function commitDelegation(
  supabase: SupabaseClient,
  orgId: string,
  taskId: string,
  actor: { id: string; label: string | null }
): Promise<DelegationCommit> {
  // Re-read the task under the org scope and confirm it's still delegable.
  const { data: task } = await supabase
    .from('human_tasks')
    .select('id, kind, status, lead_id, conversation_id, metadata')
    .eq('id', taskId)
    .eq('organization_id', orgId)
    .maybeSingle()

  if (!task) return { ok: false, status: 404, reason: 'task_not_found' }
  const cap = taskAiCapability(task as DelegableTask)
  if (!cap.capable) return { ok: false, status: 409, reason: 'task_not_delegable' }

  const stored = (task.metadata as Record<string, unknown> | null)?.ai_delegation as
    | StoredDelegationDraft
    | undefined
  if (!stored?.draft) {
    return { ok: false, status: 409, reason: 'no_preview' }
  }

  // Freshness guard: if the newest message on the thread is already outbound,
  // someone (staff or the autopilot) has answered since the preview — don't
  // double-reply. The task's own SLA/reply hooks will close it.
  const { data: latest } = await supabase
    .from('messages')
    .select('direction')
    .eq('conversation_id', task.conversation_id!)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latest?.direction === 'outbound') {
    return { ok: false, status: 409, reason: 'already_answered' }
  }

  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', task.lead_id!)
    .eq('organization_id', orgId)
    .maybeSingle()
  if (!lead) return { ok: false, status: 404, reason: 'lead_not_found' }

  const senderContact = contactFor(stored.channel, lead as Record<string, unknown>)
  if (!senderContact) {
    return { ok: false, status: 409, reason: `no_${stored.channel}_on_file` }
  }

  // Deliver the EXACT reviewed text through the shared consent-gated path,
  // stamping delegation provenance on the stored message.
  try {
    const { sendAgentResponse } = await import('@/lib/autopilot/auto-respond')
    await sendAgentResponse(supabase, {
      organization_id: orgId,
      conversation_id: task.conversation_id!,
      lead_id: task.lead_id!,
      lead: lead as Record<string, unknown>,
      channel: stored.channel,
      sender_contact: senderContact,
      agentResponse: {
        message: stored.draft,
        confidence: stored.confidence ?? 1,
        agent: (stored.agent as AgentType) ?? 'setter',
        action_taken: 'responded',
        should_handoff: false,
      },
      skipPacing: true,
      extraMetadata: {
        delegated: true,
        delegated_by: actor.id,
        delegated_by_name: actor.label,
        source_task_id: task.id,
      },
    })
  } catch (err) {
    logger.error('Delegation send failed', {
      task_id: task.id,
      error: err instanceof Error ? err.message : String(err),
    })
    // The delivery gates threw (no consent, opt-out, review block, provider
    // error). Leave the task open so a human can still handle it.
    return { ok: false, status: 422, reason: 'send_blocked' }
  }

  // Close the task in its own terminal state, crediting the delegating human as
  // the claimer for accountability (they authorized the send).
  const now = new Date().toISOString()
  await supabase
    .from('human_tasks')
    .update({
      status: 'delegated_to_ai',
      completed_at: now,
      claimed_by: actor.id,
      claimed_at: now,
      updated_at: now,
    })
    .eq('id', task.id)
    .eq('organization_id', orgId)
    .in('status', LIVE_STATUSES)

  // Authoritative provenance: who delegated what, when.
  await recordAudit(supabase, {
    organizationId: orgId,
    action: 'task.delegated_to_ai',
    actor: { actorType: 'user', actorId: actor.id, actorLabel: actor.label },
    source: 'api_route',
    resourceType: 'human_task',
    resourceId: task.id,
    metadata: {
      kind: task.kind,
      channel: stored.channel,
      conversation_id: task.conversation_id,
      lead_id: task.lead_id,
    },
  })

  return { ok: true, message: stored.draft, channel: stored.channel }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Rebuild what the reply is answering: the channel, the patient's contact, and
 * the latest inbound message (the thing the AI should respond to). Falls back to
 * the task's own detail (which for inbound_reply holds the inbound text) when the
 * thread has no stored inbound row.
 */
async function resolveReplyContext(
  supabase: SupabaseClient,
  task: DelegableTask,
  lead: Record<string, unknown>,
  conversation: Record<string, unknown>
): Promise<{ channel: 'sms' | 'email'; senderContact: string; inboundMessage: string } | null> {
  const { data: inbound } = await supabase
    .from('messages')
    .select('body, channel')
    .eq('conversation_id', task.conversation_id!)
    .eq('direction', 'inbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const channel = coerceChannel(
    (inbound?.channel as string) || (conversation.channel as string) || 'sms'
  )
  const senderContact = contactFor(channel, lead)
  if (!senderContact) return null

  const inboundMessage = (inbound?.body as string) || ''
  if (!inboundMessage.trim()) return null

  return { channel, senderContact, inboundMessage }
}

/** The patient's reachable contact for a channel (decrypted), or null. */
function contactFor(channel: 'sms' | 'email', lead: Record<string, unknown>): string | null {
  const raw = channel === 'email' ? (lead.email as string | null) : (lead.phone as string | null)
  if (!raw) return null
  return decryptField(raw) || raw
}

/** conversations.channel can be 'multi'; the reply must pick a concrete lane. */
function coerceChannel(value: string): 'sms' | 'email' {
  return value === 'email' ? 'email' : 'sms'
}

/** Store the ready draft on the task (best-effort — never throws into preview). */
async function persistDraft(
  supabase: SupabaseClient,
  orgId: string,
  taskId: string,
  stored: StoredDelegationDraft
): Promise<void> {
  try {
    // Read-modify-write the metadata blob so we don't clobber sibling keys.
    const { data: row } = await supabase
      .from('human_tasks')
      .select('metadata')
      .eq('id', taskId)
      .eq('organization_id', orgId)
      .maybeSingle()
    const metadata = { ...((row?.metadata as Record<string, unknown> | null) ?? {}), ai_delegation: stored }
    await supabase
      .from('human_tasks')
      .update({ ai_draft: stored.draft, metadata, updated_at: new Date().toISOString() })
      .eq('id', taskId)
      .eq('organization_id', orgId)
  } catch (err) {
    logger.warn('Delegation draft persist failed', {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
