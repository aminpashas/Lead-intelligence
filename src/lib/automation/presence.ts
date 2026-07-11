/**
 * Conversation Presence (Workstream D4)
 *
 * Tracks which staff user currently has which conversation thread open, via
 * a heartbeat row per (conversation, user) in `conversation_viewers` —
 * mirroring the voice_agent_presence heartbeat pattern.
 *
 * The thread UI POSTs /api/conversations/[id]/presence every ~30s while the
 * tab is visible; a user counts as "viewing" when their last_seen_at falls
 * inside the freshness window (default 75s = two missed beats + slack).
 *
 * Consumers: D5 staff notifications (src/lib/notifications/staff-notify.ts)
 * suppress pings to users already looking at the thread, and reset dedupe
 * cooldowns once a user has viewed the conversation since the last send.
 *
 * All functions fail soft — presence must never take a request path down.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

/** Default freshness window: two missed 30s heartbeats plus jitter. */
export const PRESENCE_WINDOW_SECONDS = 75

export type PresenceHeartbeatInput = {
  conversationId: string
  userId: string
  organizationId: string
}

export type ConversationViewer = {
  user_id: string
  last_seen_at: string
}

/**
 * Record (or refresh) the caller's presence on a conversation.
 * Upserts the (conversation, user) row in place.
 */
export async function heartbeatPresence(
  supabase: SupabaseClient,
  input: PresenceHeartbeatInput
): Promise<boolean> {
  try {
    const { error } = await supabase.from('conversation_viewers').upsert(
      {
        organization_id: input.organizationId,
        conversation_id: input.conversationId,
        user_id: input.userId,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'conversation_id,user_id' }
    )
    if (error) {
      logger.warn('Presence: heartbeat upsert failed', {
        conversationId: input.conversationId,
        error: error.message,
      })
      return false
    }
    return true
  } catch (err) {
    logger.warn('Presence: heartbeat failed', {
      conversationId: input.conversationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Is this user actively viewing the conversation right now?
 * Fails soft to `false` (treat as not viewing → notification still goes out).
 */
export async function isUserViewingConversation(
  supabase: SupabaseClient,
  conversationId: string,
  userId: string,
  windowSec: number = PRESENCE_WINDOW_SECONDS
): Promise<boolean> {
  try {
    const cutoff = new Date(Date.now() - windowSec * 1000).toISOString()
    const { data } = await supabase
      .from('conversation_viewers')
      .select('user_id')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .gte('last_seen_at', cutoff)
      .maybeSingle()
    return !!data
  } catch {
    return false
  }
}

/**
 * Everyone actively viewing the conversation (fresh heartbeat within the
 * window). Fails soft to an empty list.
 */
export async function getActiveViewers(
  supabase: SupabaseClient,
  conversationId: string,
  windowSec: number = PRESENCE_WINDOW_SECONDS
): Promise<ConversationViewer[]> {
  try {
    const cutoff = new Date(Date.now() - windowSec * 1000).toISOString()
    const { data } = await supabase
      .from('conversation_viewers')
      .select('user_id, last_seen_at')
      .eq('conversation_id', conversationId)
      .gte('last_seen_at', cutoff)
    return (data as ConversationViewer[]) ?? []
  } catch {
    return []
  }
}
