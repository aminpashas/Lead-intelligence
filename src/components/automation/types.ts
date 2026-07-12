/** Shared prop shapes for the Automation Command Center components. */

export type MatrixCampaign = {
  id: string
  name: string
  status: string
  channel: string
  type: string
}

export type MatrixVoiceCampaign = {
  id: string
  name: string
  status: string
  agent_type: 'setter' | 'closer'
  live_transfer_enabled: boolean
  transfer_mode: string
}

export type MatrixStage = {
  id: string
  name: string
  color: string
  position: number
}

/** organizations columns this page reads/writes (autopilot + human-first). */
export type AutomationSettings = {
  timezone?: string | null
  autopilot_enabled?: boolean
  autopilot_paused?: boolean
  autopilot_mode?: string
  autopilot_outreach_suppressed?: boolean
  autopilot_confidence_threshold?: number
  autopilot_max_messages_per_hour?: number
  autopilot_active_hours_start?: number
  autopilot_active_hours_end?: number
  autopilot_stop_words?: string[]
  autopilot_schedule?: Record<string, unknown> | null
  autopilot_speed_to_lead?: boolean
  human_first_sla_enabled?: boolean
  human_first_sla_seconds?: number
}
