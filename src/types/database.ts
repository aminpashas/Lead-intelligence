// Auto-generated types should come from `supabase gen types` in production.
// These manual types provide IDE support during development.

export type Organization = {
  id: string
  name: string
  slug: string
  logo_url: string | null
  website: string | null
  phone: string | null
  email: string | null
  address: Record<string, string> | null
  settings: Record<string, unknown>
  subscription_tier: 'trial' | 'starter' | 'professional' | 'enterprise'
  subscription_status: 'active' | 'past_due' | 'canceled' | 'trialing'
  trial_ends_at: string | null
  created_at: string
  updated_at: string
}

export type UserProfile = {
  id: string
  organization_id: string
  full_name: string
  email: string
  avatar_url: string | null
  role: 'owner' | 'admin' | 'manager' | 'member'
  is_active: boolean
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export type PipelineStage = {
  id: string
  organization_id: string
  name: string
  slug: string
  description: string | null
  color: string
  position: number
  is_default: boolean
  is_won: boolean
  is_lost: boolean
  auto_actions: unknown[]
  created_at: string
}

export type LeadSource = {
  id: string
  organization_id: string
  name: string
  type: 'google_ads' | 'meta_ads' | 'website_form' | 'landing_page' | 'referral' | 'walk_in' | 'phone' | 'email_campaign' | 'sms_campaign' | 'other'
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  cost_per_lead: number | null
  is_active: boolean
  metadata: Record<string, unknown>
  created_at: string
}

export type DentalCondition = 'missing_all_upper' | 'missing_all_lower' | 'missing_all_both' | 'missing_multiple' | 'failing_teeth' | 'denture_problems' | 'other'
export type FinancingInterest = 'cash_pay' | 'financing_needed' | 'insurance_only' | 'undecided'
export type BudgetRange = 'under_10k' | '10k_15k' | '15k_20k' | '20k_25k' | '25k_30k' | 'over_30k' | 'unknown'
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'consultation_scheduled' | 'consultation_completed' | 'treatment_presented' | 'financing' | 'contract_sent' | 'contract_signed' | 'scheduled' | 'in_treatment' | 'completed' | 'lost' | 'disqualified' | 'no_show' | 'unresponsive'
export type AIQualification = 'hot' | 'warm' | 'cold' | 'unqualified' | 'unscored'
export type LeadAIOverride = 'default' | 'force_on' | 'force_off' | 'assist_only'

export type Lead = {
  id: string
  organization_id: string

  // Basic info
  first_name: string
  last_name: string | null
  email: string | null
  phone: string | null
  phone_formatted: string | null
  email_hash: string | null
  phone_hash: string | null
  avatar_url: string | null

  // Demographics
  date_of_birth: string | null
  age: number | null
  gender: string | null
  city: string | null
  state: string | null
  zip_code: string | null
  timezone: string
  preferred_language: string

  // Dental-specific
  dental_condition: DentalCondition | null
  dental_condition_details: string | null
  current_dental_situation: string | null
  has_dentures: boolean | null
  has_dental_insurance: boolean | null
  insurance_provider: string | null
  insurance_details: Record<string, unknown> | null
  medical_conditions: string[] | null
  medications: string[] | null
  smoker: boolean | null

  // Financial
  financing_interest: FinancingInterest | null
  budget_range: BudgetRange | null
  financing_approved: boolean | null
  financing_amount: number | null

  // Pipeline
  stage_id: string | null
  status: LeadStatus

  // Source
  source_id: string | null
  source_type: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_content: string | null
  utm_term: string | null
  landing_page_url: string | null
  referrer_url: string | null
  gclid: string | null
  fbclid: string | null

  // AI scoring
  ai_score: number
  ai_qualification: AIQualification
  ai_score_breakdown: Record<string, unknown>
  ai_score_updated_at: string | null
  ai_summary: string | null

  // Engagement
  total_messages_sent: number
  total_messages_received: number
  total_emails_sent: number
  total_emails_opened: number
  total_sms_sent: number
  total_sms_received: number
  last_contacted_at: string | null
  last_responded_at: string | null
  response_time_avg_minutes: number | null
  engagement_score: number

  // Assignment
  assigned_to: string | null

  // Scheduling
  consultation_date: string | null
  consultation_type: 'in_person' | 'virtual' | 'phone' | null
  treatment_date: string | null

  // Financial
  treatment_value: number | null
  actual_revenue: number | null

  // Metadata
  tags: string[]
  custom_fields: Record<string, unknown>
  notes: string | null

  // Consent (TCPA/CAN-SPAM)
  sms_consent: boolean
  sms_consent_at: string | null
  sms_consent_source: string | null
  email_consent: boolean
  email_consent_at: string | null
  email_consent_source: string | null
  sms_opt_out: boolean
  sms_opt_out_at: string | null
  email_opt_out: boolean
  email_opt_out_at: string | null

  // Voice Consent (TCPA)
  voice_consent: boolean
  voice_consent_at: string | null
  voice_consent_source: string | null
  voice_opt_out: boolean
  voice_opt_out_at: string | null
  do_not_call: boolean

  // Enrichment
  enrichment_score: number
  enrichment_status: 'pending' | 'partial' | 'complete' | 'failed'
  enriched_at: string | null
  email_valid: boolean | null
  phone_valid: boolean | null
  phone_line_type: string | null
  ip_address: string | null
  ip_city: string | null
  ip_region: string | null
  ip_country: string | null
  distance_to_practice_miles: number | null

  // Disqualification
  disqualified_reason: string | null
  lost_reason: string | null
  no_show_count: number

  // Timestamps
  first_contact_at: string | null
  qualified_at: string | null
  converted_at: string | null
  lost_at: string | null
  created_at: string
  updated_at: string

  // Financing
  financing_application_id: string | null

  // Personality Profile (AI-analyzed)
  personality_profile: Record<string, unknown> | null

  // AI Override
  ai_autopilot_override: LeadAIOverride

  // Joined relations (optional)
  pipeline_stage?: PipelineStage
  source?: LeadSource
  assigned_user?: UserProfile
}

export type ConversationChannel = 'sms' | 'email' | 'web_chat' | 'whatsapp' | 'voice'
export type AIMode = 'auto' | 'assist' | 'off'
export type AgentType = 'setter' | 'closer' | 'none'

export type Conversation = {
  id: string
  organization_id: string
  lead_id: string
  channel: ConversationChannel
  status: 'active' | 'paused' | 'closed' | 'archived'
  subject: string | null
  ai_enabled: boolean
  ai_mode: AIMode
  sentiment: 'positive' | 'neutral' | 'negative' | 'frustrated' | null
  intent: string | null
  last_message_at: string | null
  last_message_preview: string | null
  unread_count: number
  message_count: number
  metadata: Record<string, unknown>

  // Agent system
  active_agent: AgentType
  agent_assigned_at: string | null
  agent_handoff_count: number

  created_at: string
  updated_at: string

  // Joined
  lead?: Lead
  messages?: Message[]
}

export type MessageSenderType = 'lead' | 'user' | 'ai' | 'system'
export type MessageStatus = 'pending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'bounced'

export type Message = {
  id: string
  organization_id: string
  conversation_id: string
  lead_id: string
  direction: 'inbound' | 'outbound'
  channel: ConversationChannel
  body: string
  html_body: string | null
  subject: string | null
  sender_type: MessageSenderType
  sender_id: string | null
  sender_name: string | null
  status: MessageStatus
  error_message: string | null
  external_id: string | null
  ai_generated: boolean
  ai_confidence: number | null
  ai_model: string | null
  opened_at: string | null
  clicked_at: string | null
  replied_at: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export type Campaign = {
  id: string
  organization_id: string
  created_by: string | null
  name: string
  description: string | null
  type: 'drip' | 'broadcast' | 'trigger'
  channel: 'sms' | 'email' | 'multi'
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived'
  target_criteria: Record<string, unknown>
  start_at: string | null
  end_at: string | null
  send_window: Record<string, unknown> | null
  total_enrolled: number
  total_completed: number
  total_converted: number
  total_unsubscribed: number
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  steps?: CampaignStep[]
}

export type CampaignStep = {
  id: string
  campaign_id: string
  organization_id: string
  step_number: number
  name: string | null
  channel: 'sms' | 'email'
  delay_minutes: number
  delay_type: 'after_previous' | 'after_enrollment' | 'specific_time'
  subject: string | null
  body_template: string
  ai_personalize: boolean
  send_condition: Record<string, unknown> | null
  exit_condition: Record<string, unknown> | null
  total_sent: number
  total_delivered: number
  total_opened: number
  total_replied: number
  created_at: string
}

export type AppointmentConfirmedVia = 'sms_reply' | 'email_click' | 'voice_call' | 'manual'

export type Appointment = {
  id: string
  organization_id: string
  lead_id: string
  assigned_to: string | null
  type: 'consultation' | 'follow_up' | 'treatment' | 'scan' | 'other'
  status: 'scheduled' | 'confirmed' | 'completed' | 'no_show' | 'canceled' | 'rescheduled'
  scheduled_at: string
  duration_minutes: number
  location: string | null
  notes: string | null

  // Multi-stage reminder tracking
  reminder_sent_72h: boolean
  reminder_sent_24h: boolean
  reminder_sent_2h: boolean
  reminder_sent_1h: boolean
  confirmation_call_made: boolean

  // Confirmation tracking
  confirmation_received: boolean
  confirmed_via: AppointmentConfirmedVia | null
  confirmed_at: string | null
  reschedule_requested: boolean

  // Risk assessment
  no_show_risk_score: number

  metadata: Record<string, unknown>
  created_at: string
  updated_at: string

  // Joined
  lead?: Lead
  reminders?: AppointmentReminder[]
}

export type ReminderChannel = 'sms' | 'email' | 'voice_confirmation'
export type ReminderType = '72h' | '24h' | '2h' | '1h' | 'confirmation_call' | 'manual'
export type ReminderStatus = 'pending' | 'sent' | 'delivered' | 'failed' | 'skipped'
export type ReminderConfirmationStatus = 'pending' | 'confirmed' | 'declined' | 'rescheduled' | 'no_response'

export type AppointmentReminder = {
  id: string
  organization_id: string
  appointment_id: string
  lead_id: string

  channel: ReminderChannel
  reminder_type: ReminderType

  status: ReminderStatus
  confirmation_status: ReminderConfirmationStatus

  scheduled_for: string | null
  sent_at: string | null
  response_at: string | null
  response_text: string | null

  external_id: string | null
  voice_call_id: string | null

  error_message: string | null
  metadata: Record<string, unknown>

  created_at: string
  updated_at: string
}

export type LeadActivity = {
  id: string
  organization_id: string
  lead_id: string
  user_id: string | null
  activity_type: string
  title: string
  description: string | null
  metadata: Record<string, unknown>
  created_at: string
}

// ── Patient Intelligence (AI Agents) ────────────────────────

export type PatientProfile = {
  id: string
  organization_id: string
  lead_id: string

  personality_type: string | null
  communication_style: string | null
  decision_making_style: string | null
  trust_level: string

  emotional_state: string
  anxiety_level: number
  confidence_level: number
  motivation_level: number

  pain_points: Array<{ point: string; severity: number; mentioned_count: number }>
  desires: Array<{ desire: string; importance: number; mentioned_count: number }>
  objections: Array<{ objection: string; severity: number; addressed: boolean; approach_used: string | null }>

  price_sensitivity: number
  urgency_perception: number
  negotiation_style: string | null
  influence_factors: string[]

  rapport_score: number
  personal_details: Record<string, string>
  preferred_contact_time: string | null
  preferred_channel: string | null
  humor_receptivity: string

  total_conversations_analyzed: number
  key_moments: Array<{ date: string; type: string; description: string }>

  ai_summary: string | null
  next_best_action: string | null
  recommended_tone: string | null
  topics_to_avoid: string[]
  topics_to_emphasize: string[]

  last_analyzed_at: string | null
  analysis_version: number
  created_at: string
  updated_at: string
}

export type ConversationAnalysis = {
  id: string
  organization_id: string
  conversation_id: string
  lead_id: string

  emotional_score: number | null
  engagement_score: number | null
  trust_score: number | null
  urgency_score: number | null

  patient_tone: string | null
  staff_tone: string | null
  tone_alignment: string | null

  sales_pressure_level: number | null
  empathy_level: number | null
  active_listening_score: number | null
  objection_handling_quality: number | null
  rapport_building_score: number | null

  patient_openness: number | null
  patient_buying_signals: number | null
  patient_resistance: number | null
  response_enthusiasm: string | null

  message_count: number | null
  avg_response_time_seconds: number | null
  longest_message_by: string | null
  conversation_flow: string | null
  turning_points: Array<{ message_index: number; type: string; description: string }>

  red_flags: Array<{ flag: string; severity: string; message_index: number }>
  opportunities: Array<{ opportunity: string; type: string; message_index: number }>

  coaching_notes: string | null
  improvement_areas: string[]
  things_done_well: string[]

  phi_detected: boolean
  phi_details: Array<{ category: string; message_index: number; remediation: string }>
  compliance_score: number | null
  compliance_issues: Array<{ issue: string; severity: string }>

  analyzed_at: string
  model_used: string | null
  analysis_version: number
  created_at: string
}

export type HIPAAAuditLog = {
  id: string
  organization_id: string
  event_type: string
  severity: 'info' | 'warning' | 'violation' | 'critical'
  actor_type: string
  actor_id: string | null
  resource_type: string | null
  resource_id: string | null
  description: string
  phi_categories: string[]
  remediation_action: string | null
  remediation_status: string
  ip_address: string | null
  user_agent: string | null
  metadata: Record<string, unknown>
  created_at: string
}

// ── AI Training Center ────────────────────────────────────

export type AIMemoryCategory = 'tone_and_style' | 'product_knowledge' | 'objection_handling' | 'pricing_rules' | 'compliance_rules' | 'general'

export type AIMemory = {
  id: string
  organization_id: string
  created_by: string | null
  title: string
  category: AIMemoryCategory
  content: string
  is_enabled: boolean
  priority: number
  created_at: string
  updated_at: string
}

export type AIKnowledgeCategory = 'procedures' | 'pricing' | 'faqs' | 'aftercare' | 'financing' | 'general'

export type AIKnowledgeArticle = {
  id: string
  organization_id: string
  created_by: string | null
  title: string
  category: AIKnowledgeCategory
  content: string
  tags: string[]
  is_enabled: boolean
  created_at: string
  updated_at: string
}

export type AITestMessage = {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
}

export type AITestConversation = {
  id: string
  organization_id: string
  created_by: string | null
  title: string
  mode: string
  messages: AITestMessage[]
  system_prompt_snapshot: string | null
  created_at: string
  updated_at: string
}

// ── Role Play Training Arena ─────────────────────────────────

export type RolePlayRole = 'patient' | 'treatment_coordinator'
export type RolePlayAgentTarget = 'setter' | 'closer'
export type RolePlaySessionStatus = 'active' | 'completed' | 'archived'

export type AIRolePlayMessage = {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  is_golden_example: boolean
  rating: 'good' | 'bad' | null
  coaching_note: string | null
  acting_as: RolePlayRole  // what role the sender is playing
  is_finalized: boolean         // locked as the accepted version
  retry_count: number           // how many retries this message went through
  previous_attempts: string[]   // previous AI versions before the current one
}

export type AIRolePlaySession = {
  id: string
  organization_id: string
  created_by: string | null
  title: string
  user_role: RolePlayRole         // what role the user plays
  agent_target: RolePlayAgentTarget // which agent is being trained
  scenario_id: string | null
  scenario_description: string | null
  patient_persona: {
    name: string
    personality_type: string
    dental_condition: string
    emotional_state: string
    objections: string[]
    budget_concern: string
    custom_notes: string
  } | null
  messages: AIRolePlayMessage[]
  status: RolePlaySessionStatus
  session_summary: string | null
  extracted_example_count: number
  overall_rating: number | null      // 1-5 stars
  created_at: string
  updated_at: string
}

export type AITrainingExample = {
  id: string
  organization_id: string
  session_id: string
  category: 'ideal_response' | 'objection_handling' | 'rapport_building' | 'closing_technique' | 'patient_education' | 'follow_up' | 'general'
  scenario_context: string
  patient_message: string
  ideal_response: string
  coaching_notes: string | null
  agent_target: RolePlayAgentTarget
  is_approved: boolean
  is_active: boolean
  created_at: string
  updated_at: string
}

export type RolePlayScenario = {
  id: string
  name: string
  description: string
  category: 'new_patient' | 'objection' | 'follow_up' | 'closing' | 're_engagement' | 'custom'
  agent_target: RolePlayAgentTarget
  patient_persona: AIRolePlaySession['patient_persona']
  difficulty: 'easy' | 'medium' | 'hard'
  is_built_in: boolean
}

// ── Financing (re-exported from lib/financing/types) ────────────

// Note: Full financing types are in src/lib/financing/types.ts
// These re-exports provide convenience access from the central types file
export type {
  LenderSlug,
  FinancingLenderConfig,
  FinancingApplication,
  FinancingSubmission,
  FinancingApplicationStatus,
  FinancingSubmissionStatus,
  ApprovedTerms,
  WaterfallConfig,
} from '@/lib/financing/types'

// ── Agent Handoffs ──────────────────────────────────────────

export type AgentHandoff = {
  id: string
  organization_id: string
  conversation_id: string
  lead_id: string
  from_agent: AgentType | 'manual'
  to_agent: AgentType | 'manual'
  trigger_reason: string
  context_snapshot: Record<string, unknown>
  initiated_by: 'system' | 'user' | 'ai'
  initiated_by_user_id: string | null
  created_at: string
}

// ── AI Conversation Ratings (Admin Audit) ───────────────────

export type AIConversationRating = {
  id: string
  organization_id: string
  conversation_id: string
  lead_id: string
  rated_by: string
  rating: number
  notes: string | null
  flagged: boolean
  created_at: string
  updated_at: string
}

// ── Tags & Smart Lists ──────────────────────────────────────

export type TagCategory = 'pipeline_stage' | 'score' | 'interest' | 'behavior' | 'custom'

export type Tag = {
  id: string
  organization_id: string
  name: string
  slug: string
  color: string
  category: TagCategory
  description: string | null
  lead_count: number
  created_by: string | null
  created_at: string
}

export type LeadTag = {
  id: string
  lead_id: string
  tag_id: string
  organization_id: string
  tagged_by: string | null
  tagged_at: string
  tag?: Tag
}

export type SmartListCriteria = {
  tags?: { ids: string[]; operator: 'and' | 'or' }
  statuses?: string[]
  ai_qualifications?: string[]
  score_min?: number
  score_max?: number
  stages?: string[]
  source_types?: string[]
  engagement_min?: number
  engagement_max?: number
  states?: string[]
  created_after?: string
  created_before?: string
  has_phone?: boolean
  has_email?: boolean
  sms_consent?: boolean
  email_consent?: boolean
}

export type SmartList = {
  id: string
  organization_id: string
  name: string
  description: string | null
  icon: string | null
  color: string
  criteria: SmartListCriteria
  is_pinned: boolean
  lead_count: number
  last_refreshed_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

// ── Reactivation Campaigns ──────────────────────────────

export type ReactivationGoal = 're_engage' | 'win_back' | 'upsell' | 'referral_ask'
export type ReactivationTone = 'empathetic' | 'urgent' | 'casual' | 'professional'
export type ReactivationHookStrategy = 'urgency' | 'social_proof' | 'new_technology' | 'special_pricing' | 'empathy' | 'personalized_value'

export type ReactivationCampaign = {
  id: string
  organization_id: string
  campaign_id: string | null
  created_by: string | null
  name: string
  description: string | null
  goal: ReactivationGoal
  tone: ReactivationTone
  ai_hooks: Array<{
    strategy: ReactivationHookStrategy
    enabled: boolean
    custom_text: string | null
  }>
  engagement_rules: {
    max_attempts: number
    cooldown_days: number
    escalation_strategy: string
    stop_on_reply: boolean
    transition_to_live: boolean
  }
  channel: 'sms' | 'email' | 'multi'
  status: 'draft' | 'active' | 'paused' | 'completed' | 'archived'
  total_uploaded: number
  total_reactivated: number
  total_responded: number
  total_converted: number
  last_upload_at: string | null
  upload_count: number
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
  // Joined
  offers?: ReactivationOffer[]
  campaign?: Campaign
}

export type ReactivationOfferType = 'percentage_off' | 'dollar_off' | 'free_addon' | 'financing_special' | 'limited_time'

export type ReactivationOffer = {
  id: string
  organization_id: string
  reactivation_campaign_id: string
  name: string
  description: string | null
  type: ReactivationOfferType
  value: number | null
  expiry_date: string | null
  usage_limit: number | null
  times_used: number
  is_active: boolean
  created_at: string
  updated_at: string
}

// ── Voice Calling ───────────────────────────────────────────

export type VoiceCallStatus = 'initiated' | 'ringing' | 'in_progress' | 'completed' | 'no_answer' | 'busy' | 'failed' | 'voicemail' | 'canceled'
export type VoiceCallOutcome = 'appointment_booked' | 'callback_requested' | 'interested' | 'not_interested' | 'wrong_number' | 'do_not_call' | 'voicemail_left' | 'no_answer' | 'technical_failure' | 'transferred'
export type VoiceCampaignStatus = 'draft' | 'scheduled' | 'active' | 'paused' | 'completed' | 'archived'
export type VoiceCampaignLeadStatus = 'queued' | 'calling' | 'completed' | 'skipped' | 'failed' | 'do_not_call'

export type VoiceCallTranscriptEntry = {
  role: 'agent' | 'lead'
  content: string
  timestamp_ms: number
}

export type VoiceCall = {
  id: string
  organization_id: string
  lead_id: string
  conversation_id: string | null

  direction: 'inbound' | 'outbound'
  status: VoiceCallStatus

  // External IDs
  retell_call_id: string | null
  twilio_call_sid: string | null

  // Call details
  from_number: string
  to_number: string
  duration_seconds: number
  started_at: string | null
  answered_at: string | null
  ended_at: string | null

  // AI Agent
  agent_type: AgentType | null
  ai_confidence_avg: number | null

  // Recording & Transcript
  recording_url: string | null
  recording_duration_seconds: number | null
  transcript: VoiceCallTranscriptEntry[]
  transcript_summary: string | null

  // Outcome
  outcome: VoiceCallOutcome | null
  outcome_notes: string | null

  // Campaign link
  voice_campaign_id: string | null

  // Compliance
  consent_verified: boolean
  recording_disclosure_given: boolean
  tcpa_compliant: boolean

  metadata: Record<string, unknown>
  created_at: string
  updated_at: string

  // Joined
  lead?: Lead
}

export type VoiceCampaign = {
  id: string
  organization_id: string
  created_by: string | null

  name: string
  description: string | null

  status: VoiceCampaignStatus

  // Targeting
  smart_list_id: string | null
  target_criteria: Record<string, unknown>

  // Schedule
  scheduled_start_at: string | null
  scheduled_end_at: string | null
  active_hours_start: number
  active_hours_end: number
  active_days: string[]
  timezone: string

  // Dialing config
  max_attempts_per_lead: number
  retry_delay_hours: number
  concurrent_calls: number
  calls_per_hour: number

  // AI config
  agent_type: 'setter' | 'closer'
  custom_greeting: string | null
  custom_voicemail: string | null

  // Stats
  total_leads: number
  total_called: number
  total_connected: number
  total_appointments: number
  total_voicemails: number
  total_no_answer: number
  total_do_not_call: number
  avg_call_duration_seconds: number

  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type VoiceCampaignLead = {
  id: string
  voice_campaign_id: string
  lead_id: string
  organization_id: string

  status: VoiceCampaignLeadStatus
  attempts: number
  last_attempt_at: string | null
  last_call_id: string | null
  outcome: string | null

  priority: number
  scheduled_at: string | null

  created_at: string
  updated_at: string

  // Joined
  lead?: Lead
}
