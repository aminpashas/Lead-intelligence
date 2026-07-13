/**
 * Conversation threads + workflow single-flight lock.
 *
 * A single SMS/email conversation routinely carries more than one topic at once:
 * a nurture "here's a patient story" touch, a scheduling "here are your open
 * slots" reply, a financing follow-up. Historically every workflow — inbound
 * auto-respond, the follow-up-sequences cron, speed-to-lead, campaigns — composed
 * and sent into the single conversation row with nothing coordinating them, so
 * two workflows firing in the same beat talked over each other (the classic
 * "patient story immediately followed by an unrelated scheduling reply").
 *
 * This module provides the two primitives that fix that:
 *
 *  1. THREADS ({@link getOrCreateThread}, {@link resolveThread}) — a topic
 *     sub-thread inside a conversation. Outbound messages are attributed to a
 *     thread so each topic stays legible instead of interleaving.
 *
 *  2. THE LOCK ({@link claimConversationWorkflow}, {@link releaseConversationWorkflow},
 *     {@link withConversationWorkflowLock}) — a short-lived, lease-based lock keyed
 *     on the conversation. A workflow claims it before composing+sending; a second
 *     workflow that finds a live lease held by someone else STANDS DOWN rather
 *     than firing. Leases carry a TTL and auto-expire, so a crashed holder never
 *     wedges the conversation.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

/**
 * Canonical topics a thread can track. Stored as free text in the DB (so new
 * topics ship without a migration), but callers should use these values.
 */
export type ConversationTopic =
  | 'scheduling' // booking / slot negotiation
  | 'nurture' // patient stories, education, re-engagement content
  | 'financing' // payment plans, financing follow-up
  | 'clinical' // medical questions (escalated to a human)
  | 'reminder' // appointment reminders / confirmations
  | 'reengagement' // dormant-lead revival
  | 'general' // uncategorized / default

/**
 * The workflows that can drive a conversation. Used as the lock holder label so
 * logs read "auto_respond blocked by sequence" rather than an opaque id.
 */
export type WorkflowKind =
  | 'auto_respond' // inbound AI reply (Twilio / email-reply webhook)
  | 'speed_to_lead' // proactive first outreach
  | 'sequence' // follow-up-sequences cron nurture step
  | 'campaign' // mass / campaign send
  | 'reminder' // appointment reminder cron
  | 'reengagement' // dormant sweep
  | 'sla_takeover' // human-SLA lapse → AI takes the reply

const LOCKS_RPC_CLAIM = 'claim_conversation_workflow'
const LOCKS_RPC_RELEASE = 'release_conversation_workflow'

/** Default lease length. Long enough to cover an agent round-trip + send. */
export const DEFAULT_WORKFLOW_LOCK_TTL_SECONDS = 120

export type ClaimResult = {
  /** True when this workflow now holds the lease (fresh, refreshed, or stolen). */
  acquired: boolean
  /** The workflow that currently holds the conversation (this one, or the blocker). */
  holder: string | null
  /** When the current lease expires. */
  expiresAt: string | null
}

/**
 * Attempt to claim (or refresh) the conversation's workflow lease.
 *
 * Returns `acquired: false` — with `holder` naming the incumbent — when a live
 * lease is held by a DIFFERENT workflow. The caller must not send in that case.
 * Re-entrant: the same workflow calling twice refreshes its own lease.
 *
 * Fail-open on infrastructure error: if the RPC itself throws (missing migration,
 * transient DB error) we log and return `acquired: true`. Coordination is a
 * safety improvement layered on top of the existing behavior — a broken lock must
 * never silence a conversation entirely.
 */
export async function claimConversationWorkflow(
  supabase: SupabaseClient,
  params: {
    conversationId: string
    organizationId: string
    workflow: WorkflowKind
    ttlSeconds?: number
  }
): Promise<ClaimResult> {
  const { conversationId, organizationId, workflow } = params
  const ttl = params.ttlSeconds ?? DEFAULT_WORKFLOW_LOCK_TTL_SECONDS

  try {
    const { data, error } = await supabase.rpc(LOCKS_RPC_CLAIM, {
      p_conversation_id: conversationId,
      p_organization_id: organizationId,
      p_workflow: workflow,
      p_ttl_seconds: ttl,
    })
    if (error) throw error

    // The RPC returns a single-row set: [{ acquired, holder, expires_at }].
    const row = Array.isArray(data) ? data[0] : data
    if (!row) {
      // No row back is unexpected; treat as fail-open so we never wedge sends.
      return { acquired: true, holder: workflow, expiresAt: null }
    }
    return {
      acquired: row.acquired === true,
      holder: (row.holder as string | null) ?? null,
      expiresAt: (row.expires_at as string | null) ?? null,
    }
  } catch (err) {
    logger.warn('Conversation workflow lock claim failed (failing open)', {
      conversationId,
      workflow,
      error: err instanceof Error ? err.message : String(err),
    })
    return { acquired: true, holder: workflow, expiresAt: null }
  }
}

/**
 * Release the lease — but only if THIS workflow still holds it (the RPC checks
 * the holder). Best-effort: a failed release just lets the lease lapse via TTL.
 */
export async function releaseConversationWorkflow(
  supabase: SupabaseClient,
  conversationId: string,
  workflow: WorkflowKind
): Promise<void> {
  try {
    await supabase.rpc(LOCKS_RPC_RELEASE, {
      p_conversation_id: conversationId,
      p_workflow: workflow,
    })
  } catch (err) {
    logger.warn('Conversation workflow lock release failed (lease will expire)', {
      conversationId,
      workflow,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Run `fn` while holding the conversation's workflow lease. If another workflow
 * holds it, `fn` never runs and `{ ran: false }` is returned so the caller can
 * report a "deferred" outcome. The lease is always released afterward.
 */
export async function withConversationWorkflowLock<T>(
  supabase: SupabaseClient,
  params: {
    conversationId: string
    organizationId: string
    workflow: WorkflowKind
    ttlSeconds?: number
  },
  fn: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false; holder: string | null }> {
  const claim = await claimConversationWorkflow(supabase, params)
  if (!claim.acquired) {
    logger.info('Workflow stood down — conversation held by another workflow', {
      conversationId: params.conversationId,
      workflow: params.workflow,
      heldBy: claim.holder,
    })
    return { ran: false, holder: claim.holder }
  }
  try {
    const result = await fn()
    return { ran: true, result }
  } finally {
    await releaseConversationWorkflow(supabase, params.conversationId, params.workflow)
  }
}

export type ConversationThread = {
  id: string
  organization_id: string
  conversation_id: string
  lead_id: string
  topic: string
  title: string | null
  status: 'open' | 'resolved' | 'superseded'
  opened_by: string | null
  last_message_at: string | null
  last_message_preview: string | null
  message_count: number
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  resolved_at: string | null
}

/**
 * Resolve the open thread for a (conversation, topic), creating one if none is
 * open. The `conversation_threads_one_open_per_topic` partial unique index means
 * concurrent callers can't create duplicates — the loser re-selects the winner's
 * row (mirrors the ensureNurturingStageId race handling elsewhere).
 *
 * Never throws: on any failure it returns null and the caller proceeds without a
 * thread_id (attribution degrades, messaging does not break).
 */
export async function getOrCreateThread(
  supabase: SupabaseClient,
  params: {
    conversationId: string
    organizationId: string
    leadId: string
    topic: ConversationTopic | string
    title?: string
    openedBy?: WorkflowKind
  }
): Promise<ConversationThread | null> {
  const { conversationId, organizationId, leadId, topic } = params
  try {
    const existing = await selectOpenThread(supabase, conversationId, topic)
    if (existing) return existing

    const { data: created, error } = await supabase
      .from('conversation_threads')
      .insert({
        organization_id: organizationId,
        conversation_id: conversationId,
        lead_id: leadId,
        topic,
        title: params.title ?? null,
        status: 'open',
        opened_by: params.openedBy ?? null,
      })
      .select('*')
      .single()

    if (!error && created) return created as ConversationThread

    // Lost the race against a concurrent open on the same topic (unique index) —
    // the other insert's row is now the canonical open thread.
    return await selectOpenThread(supabase, conversationId, topic)
  } catch (err) {
    logger.warn('getOrCreateThread failed (proceeding without thread)', {
      conversationId,
      topic,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function selectOpenThread(
  supabase: SupabaseClient,
  conversationId: string,
  topic: string
): Promise<ConversationThread | null> {
  const { data } = await supabase
    .from('conversation_threads')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('topic', topic)
    .eq('status', 'open')
    .limit(1)
    .maybeSingle()
  return (data as ConversationThread | null) ?? null
}

/**
 * Record activity on a thread: bump its message count and last-activity stamp.
 * Best-effort; a missed bump only affects thread ordering, never delivery.
 */
export async function touchThread(
  supabase: SupabaseClient,
  threadId: string,
  lastMessagePreview?: string
): Promise<void> {
  try {
    await supabase.rpc('increment_conversation_thread_activity', {
      p_thread_id: threadId,
      p_last_message_preview: lastMessagePreview ?? null,
    })
  } catch {
    // RPC is optional sugar; fall back to a direct timestamp touch.
    try {
      await supabase
        .from('conversation_threads')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', threadId)
    } catch {
      /* non-critical */
    }
  }
}

/** Mark a thread resolved / superseded so a new one opens next time. */
export async function resolveThread(
  supabase: SupabaseClient,
  threadId: string,
  status: 'resolved' | 'superseded' = 'resolved'
): Promise<void> {
  try {
    await supabase
      .from('conversation_threads')
      .update({ status, resolved_at: new Date().toISOString() })
      .eq('id', threadId)
  } catch (err) {
    logger.warn('resolveThread failed', {
      threadId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Lightweight, dependency-free topic inference from an inbound message. Cheap
 * keyword screen — deliberately NOT an LLM call — used to attribute an inbound
 * SMS/email to a topic thread. Falls back to the conversation's stored `intent`
 * (if it maps cleanly) and finally to 'general'.
 */
export function inferTopic(
  message: string,
  fallbackIntent?: string | null
): ConversationTopic {
  const t = (message || '').toLowerCase()

  // Scheduling: slots, times, booking, availability, confirm/reschedule. Times of
  // day only count with a leading digit (10am, 2 pm) so a bare "I am" doesn't
  // register as scheduling.
  if (
    /\b(book|booking|schedule|reschedul|appointment|appt|slot|availab|calendar|what\s*time|morning|afternoon|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(
      t
    ) ||
    /\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)\b/.test(t)
  ) {
    return 'scheduling'
  }
  // Financing: cost, price, payment, insurance, afford, finance.
  if (/\b(financ|payment\s*plan|monthly|afford|insurance|cost|price|quote|how\s*much|down\s*payment|credit)\b/.test(t)) {
    return 'financing'
  }
  // Clinical: pain, symptom, medication, procedure specifics.
  if (/\b(pain|hurt|swell|infection|bleed|numb|medication|dosage|antibiotic|symptom|side\s*effect|recovery|heal)\b/.test(t)) {
    return 'clinical'
  }

  // Map a stored conversation intent onto a topic when the message itself is neutral.
  const intent = (fallbackIntent || '').toLowerCase()
  if (intent.includes('book') || intent.includes('schedul')) return 'scheduling'
  if (intent.includes('financ') || intent.includes('price') || intent.includes('cost')) return 'financing'
  if (intent.includes('educat') || intent.includes('nurtur')) return 'nurture'

  return 'general'
}
