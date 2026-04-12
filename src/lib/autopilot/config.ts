/**
 * Autopilot Configuration Module
 *
 * Loads org-level autopilot settings, evaluates whether to auto-respond,
 * detects stop words, and calculates humanized response delays.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type DaySchedule = {
  enabled: boolean
  start: number // 0-23
  end: number   // 0-23
  mode?: 'full' | 'review_first' | 'review_closers'
}

export type WeekSchedule = {
  sunday: DaySchedule
  monday: DaySchedule
  tuesday: DaySchedule
  wednesday: DaySchedule
  thursday: DaySchedule
  friday: DaySchedule
  saturday: DaySchedule
}

export type AutopilotConfig = {
  enabled: boolean
  paused: boolean
  confidence_threshold: number
  mode: 'full' | 'review_first' | 'review_closers'
  response_delay_min: number // seconds
  response_delay_max: number // seconds
  max_messages_per_hour: number
  active_hours_start: number // 0-23
  active_hours_end: number   // 0-23
  stop_words: string[]
  speed_to_lead: boolean
  schedule: WeekSchedule | null
}

const DEFAULT_DAY: DaySchedule = { enabled: true, start: 8, end: 21 }
const DEFAULT_DAY_OFF: DaySchedule = { enabled: false, start: 8, end: 21 }

export const DEFAULT_SCHEDULE: WeekSchedule = {
  sunday: DEFAULT_DAY_OFF,
  monday: DEFAULT_DAY,
  tuesday: DEFAULT_DAY,
  wednesday: DEFAULT_DAY,
  thursday: DEFAULT_DAY,
  friday: DEFAULT_DAY,
  saturday: DEFAULT_DAY_OFF,
}

const DEFAULT_CONFIG: AutopilotConfig = {
  enabled: false,
  paused: false,
  confidence_threshold: 0.75,
  mode: 'full',
  response_delay_min: 30,
  response_delay_max: 180,
  max_messages_per_hour: 10,
  active_hours_start: 8,
  active_hours_end: 21,
  stop_words: ['stop', 'unsubscribe', 'opt out', 'opt-out', 'talk to a person', 'speak to someone', 'cancel'],
  speed_to_lead: true,
  schedule: null,
}

/**
 * Fetch autopilot configuration for an organization.
 */
export async function getAutopilotConfig(
  supabase: SupabaseClient,
  organizationId: string
): Promise<AutopilotConfig> {
  const { data } = await supabase
    .from('organizations')
    .select(`
      autopilot_enabled,
      autopilot_paused,
      autopilot_confidence_threshold,
      autopilot_mode,
      autopilot_response_delay_min,
      autopilot_response_delay_max,
      autopilot_max_messages_per_hour,
      autopilot_active_hours_start,
      autopilot_active_hours_end,
      autopilot_stop_words,
      autopilot_speed_to_lead,
      autopilot_schedule
    `)
    .eq('id', organizationId)
    .single()

  if (!data) return DEFAULT_CONFIG

  return {
    enabled: data.autopilot_enabled ?? false,
    paused: data.autopilot_paused ?? false,
    confidence_threshold: data.autopilot_confidence_threshold ?? 0.75,
    mode: data.autopilot_mode ?? 'full',
    response_delay_min: data.autopilot_response_delay_min ?? 30,
    response_delay_max: data.autopilot_response_delay_max ?? 180,
    max_messages_per_hour: data.autopilot_max_messages_per_hour ?? 10,
    active_hours_start: data.autopilot_active_hours_start ?? 8,
    active_hours_end: data.autopilot_active_hours_end ?? 21,
    stop_words: data.autopilot_stop_words ?? DEFAULT_CONFIG.stop_words,
    speed_to_lead: data.autopilot_speed_to_lead ?? true,
    schedule: (data.autopilot_schedule as WeekSchedule | null) ?? null,
  }
}

/**
 * Determine whether autopilot should auto-respond for this situation.
 */
export function shouldAutoRespond(
  config: AutopilotConfig,
  context: {
    confidence: number
    agentType: 'setter' | 'closer' | 'none'
    isFirstMessage: boolean
    currentHour: number
  }
): { allowed: boolean; reason: string } {
  // Kill switch
  if (!config.enabled || config.paused) {
    return { allowed: false, reason: 'autopilot_disabled' }
  }

  // Day-of-week schedule check (takes priority over simple active hours)
  if (config.schedule) {
    const dayNames: Array<keyof WeekSchedule> = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    const today = dayNames[new Date().getDay()]
    const dayConfig = config.schedule[today]

    if (!dayConfig.enabled) {
      return { allowed: false, reason: `day_disabled_${today}` }
    }

    if (context.currentHour < dayConfig.start || context.currentHour >= dayConfig.end) {
      return { allowed: false, reason: 'outside_schedule_hours' }
    }

    // Day-specific mode override
    if (dayConfig.mode) {
      if (dayConfig.mode === 'review_first' && context.isFirstMessage) {
        return { allowed: false, reason: 'review_first_message' }
      }
      if (dayConfig.mode === 'review_closers' && context.agentType === 'closer') {
        return { allowed: false, reason: 'review_closer_responses' }
      }
    }
  } else {
    // Fallback to simple active hours
    if (context.currentHour < config.active_hours_start || context.currentHour >= config.active_hours_end) {
      return { allowed: false, reason: 'outside_active_hours' }
    }
  }

  // Confidence threshold
  if (context.confidence < config.confidence_threshold) {
    return { allowed: false, reason: 'low_confidence' }
  }

  // Mode-based restrictions (org-level, if no day-specific override)
  if (config.mode === 'review_first' && context.isFirstMessage) {
    return { allowed: false, reason: 'review_first_message' }
  }

  if (config.mode === 'review_closers' && context.agentType === 'closer') {
    return { allowed: false, reason: 'review_closer_responses' }
  }

  // No agent assigned (completed/lost stages)
  if (context.agentType === 'none') {
    return { allowed: false, reason: 'no_active_agent' }
  }

  return { allowed: true, reason: 'approved' }
}

/**
 * Check if a message contains a stop word (opt-out signal).
 * Case-insensitive, checks for exact phrase matches.
 */
export function detectStopWord(
  message: string,
  stopWords: string[]
): { detected: boolean; word: string | null } {
  const normalized = message.toLowerCase().trim()

  for (const word of stopWords) {
    if (normalized === word || normalized.includes(word)) {
      return { detected: true, word }
    }
  }

  return { detected: false, word: null }
}

/**
 * Get a randomized response delay (in milliseconds) to feel human.
 * Uses a weighted distribution that skews toward shorter delays.
 */
export function getResponseDelay(config: AutopilotConfig): number {
  const min = config.response_delay_min * 1000
  const max = config.response_delay_max * 1000
  // Weighted toward faster responses (square root distribution)
  const random = Math.sqrt(Math.random())
  return Math.round(min + random * (max - min))
}

/**
 * Check if the conversation has exceeded the hourly message limit.
 */
export async function checkMessageRateLimit(
  supabase: SupabaseClient,
  conversationId: string,
  maxPerHour: number
): Promise<boolean> {
  const { data } = await supabase.rpc('count_ai_messages_last_hour', {
    p_conversation_id: conversationId,
  })

  return (data ?? 0) < maxPerHour
}
