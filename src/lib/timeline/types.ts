import type { Message, VoiceCall, LeadActivity } from '@/types/database'

/** A single, normalized item in a lead's unified channel feed. */
export type TimelineEntry =
  | {
      kind: 'message'
      id: string
      at: string
      channel: Message['channel']
      direction: Message['direction']
      body: string
      subject: string | null
      status: Message['status']
      aiGenerated: boolean
      senderType: Message['sender_type']
      senderName: string | null
    }
  | {
      kind: 'call'
      id: string
      at: string
      direction: VoiceCall['direction']
      outcome: VoiceCall['outcome']
      durationSeconds: number
      notes: string | null
      transcriptSummary: string | null
      recordingUrl: string | null
      status: VoiceCall['status']
      /** How the call was placed — 'ai' vs a human via the browser softphone. */
      callMode: VoiceCall['call_mode']
      /** AI agent persona for AI-driven calls (setter/closer). */
      agentType: VoiceCall['agent_type']
      /** Staff member who placed a human call; resolved to a name at render. */
      staffUserId: string | null
    }
  | { kind: 'note'; id: string; at: string; title: string; body: string }
  | { kind: 'stage_change'; id: string; at: string; title: string; body: string | null }

/** Raw rows the timeline builder consumes (already org-scoped by the caller). */
export interface TimelineInput {
  messages: Pick<
    Message,
    'id' | 'created_at' | 'channel' | 'direction' | 'body' | 'subject' | 'status' | 'ai_generated' | 'sender_type' | 'sender_name'
  >[]
  calls: Pick<
    VoiceCall,
    'id' | 'created_at' | 'started_at' | 'direction' | 'outcome' | 'duration_seconds' | 'outcome_notes' | 'transcript_summary' | 'recording_url' | 'status' | 'call_mode' | 'agent_type' | 'staff_user_id'
  >[]
  activities: Pick<LeadActivity, 'id' | 'created_at' | 'activity_type' | 'title' | 'description'>[]
}
