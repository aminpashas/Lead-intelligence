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
  feature_flags: Record<string, boolean>
  dion_practice_id: string | null
  // Sellable tiers are basic | growth | full (see src/lib/billing/tiers.ts). starter/professional/
  // enterprise are legacy tiers retained for back-compat on existing subscriptions.
  subscription_tier: 'trial' | 'basic' | 'growth' | 'full' | 'starter' | 'professional' | 'enterprise'
  subscription_status: 'active' | 'past_due' | 'canceled' | 'trialing'
  trial_ends_at: string | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  // Optional parent enterprise (DSO). NULL = standalone single-location practice.
  enterprise_account_id: string | null
  created_at: string
  updated_at: string
}

// DSO/enterprise umbrella grouping N locations (organizations). Admin + reporting
// only — billing/pricing stay per-location. Agency-admin managed (migration
// 20260711220000_enterprise_accounts).
export type EnterpriseAccount = {
  id: string
  name: string
  slug: string
  created_at: string
  updated_at: string
}

// Per agency-admin selection of which client org they are currently "inside".
// Drives the context-aware get_user_org_id() (migration 038).
export type AgencyActiveOrg = {
  user_id: string
  active_org_id: string
  updated_at: string
}

export type UserProfile = {
  id: string
  organization_id: string
  full_name: string
  email: string
  avatar_url: string | null
  role:
    | 'doctor_admin'
    | 'doctor'
    | 'nurse'
    | 'assistant'
    | 'treatment_coordinator'
    | 'office_manager'
    | 'owner'
    | 'admin'
    | 'manager'
    | 'member'
    | 'agency_admin'
  is_active: boolean
  last_seen_at: string | null
  job_title: string | null
  specialty: string | null
  phone: string | null
  invited_by: string | null
  invited_at: string | null
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
// Casual credit bucket captured during discovery — feeds financial-readiness scoring.
export type CreditRange = 'excellent' | 'good' | 'fair' | 'rebuilding' | 'unknown'
export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'consultation_scheduled' | 'consultation_completed' | 'treatment_presented' | 'financing' | 'contract_sent' | 'contract_signed' | 'scheduled' | 'in_treatment' | 'completed' | 'lost' | 'disqualified' | 'no_show' | 'unresponsive' | 'dormant'
export type AIQualification = 'hot' | 'warm' | 'cold' | 'unqualified' | 'unscored'
export type LeadAIOverride = 'default' | 'force_on' | 'force_off' | 'assist_only'
export type FinancialQualificationTier = 'tier_a' | 'tier_b' | 'tier_c' | 'tier_d'

export type FinancialSignals = {
  has_insurance: boolean | null
  insurance_provider: string | null
  financing_interest: 'low' | 'medium' | 'high' | null
  budget_monthly: number | null
  down_payment_mentioned: number | null
  has_savings: boolean | null
  has_hsa_fsa: boolean | null
  price_aware: boolean
  financing_curious: boolean
  budget_conscious: boolean
  barriers: string[]
  readiness_score: number
  last_updated: string
}

export type FinancingContext = {
  status: 'none' | 'pending' | 'approved' | 'denied' | 'partial'
  approved_amount?: number
  monthly_payment?: number
  apr?: number
  term_months?: number
  lender?: string
  denied_lenders?: string[]
  readiness_score: number
  qualification_tier: FinancialQualificationTier
  budget_breakdown?: {
    treatment_value: number
    insurance_coverage: number
    hsa_fsa: number
    down_payment: number
    amount_to_finance: number
    estimated_monthly: number
  }
}

// Campaign-level attribution resolved by Dion Growth Studio and synced over
// the /api/v1/leads bridge (leads.campaign_attribution jsonb). All keys
// optional — the resolver degrades from exact campaign match (confidence 1.0)
// down to channel-only guesses (0.3).
export type CampaignAttribution = {
  channel?: string
  campaign_id?: string
  campaign_name?: string
  ad_group_id?: string
  ad_group_name?: string
  keyword_text?: string
  click_id_type?: string
  attribution_model?: string
  attribution_confidence?: number
  resolved_at?: string
  source_system?: string
}

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
  credit_range: CreditRange | null
  timeline_note: string | null
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
  campaign_attribution: CampaignAttribution | null

  // AI scoring
  ai_score: number
  ai_qualification: AIQualification
  ai_score_breakdown: Record<string, unknown>
  ai_score_updated_at: string | null
  ai_summary: string | null

  // Conversation analysis (compact sweep — see /api/cron/analyze-conversations)
  conversation_intent: ConversationIntent | null
  conversation_sentiment: ConversationSentiment | null
  primary_objection: PrimaryObjection | null
  conversation_red_flag: boolean
  conversation_analyzed_at: string | null
  /** One-line plain-English recap of the latest conversation (sweep-written). */
  conversation_summary: string | null

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
  /** Set when a consultation appointment is marked completed (attend-but-no-close window opens). */
  consult_completed_at: string | null
  treatment_date: string | null

  // Financial
  treatment_value: number | null
  actual_revenue: number | null

  // In-Closing workflow (/closing board). Manual temperature is an override of
  // the derived value (see src/lib/pipeline/closing.ts); null = use derived.
  // 'deliberating' is manual-only: patient saw the plan and is actively deciding
  // ("thinking / spouse / saving up"); closing_follow_up_at carries the date to
  // circle back, so the deal is muted from the live queue until then.
  closing_temperature: 'hot' | 'warm' | 'cold' | 'stalled' | 'deliberating' | null
  closing_next_step: string | null
  closing_updated_at: string | null
  closing_follow_up_at: string | null

  // Clinical visit outcome (Dion Clinical scribe → LI, see dion-encounter-brief.ts).
  // appointment_summary is INTERNAL clinical narrative — steers follow-ups, never
  // disclosed to the patient. dion_patient_id is the suite-wide identity link,
  // backfilled when an encounter brief matches this lead.
  dion_patient_id: string | null
  appointment_summary: string | null
  last_encounter_brief_at: string | null

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

  // Consent status (tri-state, additive to the booleans above)
  sms_consent_status: 'granted' | 'declined' | 'unknown'
  email_consent_status: 'granted' | 'declined' | 'unknown'
  voice_consent_status: 'granted' | 'declined' | 'unknown'

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

  // Financial Qualification (AI-driven)
  financial_qualification_tier: FinancialQualificationTier | null
  financial_qualification_status: 'unassessed' | 'assessed'
  financing_readiness_score: number
  financial_signals: FinancialSignals | null
  financing_link_sent_at: string | null
  preferred_monthly_budget: number | null
  has_hsa_fsa: boolean | null
  estimated_down_payment: number | null
  financial_coaching_notes: string | null

  // Personality Profile (AI-analyzed)
  personality_profile: Record<string, unknown> | null

  // AI Override
  ai_autopilot_override: LeadAIOverride

  // EHR reconciliation — set when this contact already exists as a synced
  // patient (patients table). Existing patients are excluded from new-lead
  // pools and never auto-outreached by speed-to-lead.
  is_existing_patient: boolean
  matched_patient_id: string | null

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

  // HIPAA identity verification gate
  identity_verified_at: string | null
  identity_verified_via: string | null

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
  /** Re-permission override: may email consent-unknown leads. Never overrides opt-out/declined. Email only. */
  allow_unconsented_email: boolean
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
  /** Per-step generator/intent config, e.g. {"ai_generator":"closer","nurture_goal":"..."}. */
  metadata: Record<string, unknown> | null
  total_sent: number
  total_delivered: number
  total_opened: number
  total_replied: number
  created_at: string
}

export type AppointmentConfirmedVia = 'sms_reply' | 'email_click' | 'voice_call' | 'manual'

export type EhrSyncStatus = 'pending' | 'synced' | 'failed' | 'skipped'

export type Appointment = {
  id: string
  organization_id: string
  lead_id: string
  assigned_to: string | null
  type: 'consultation' | 'follow_up' | 'treatment' | 'scan' | 'other'
  // 'pending_card' is a held slot awaiting a card-on-file (card_on_file_required
  // mode) — NOT a confirmed booking. The Stripe webhook flips it to 'scheduled'
  // once the card lands. Excluded from confirmed views, reminders, and counts.
  status: 'scheduled' | 'confirmed' | 'completed' | 'no_show' | 'canceled' | 'rescheduled' | 'pending_card'
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

  // Phone-first protocol: which path booked this + soft-gate override audit
  booked_via: 'ai' | 'staff' | 'public' | null
  call_gate_overridden: boolean
  override_reason: string | null
  override_by: string | null

  // Card-on-file (Stripe SetupIntent) + no-show fee lifecycle
  card_on_file: boolean
  stripe_customer_id: string | null
  stripe_payment_method_id: string | null
  no_show_fee_status: 'none' | 'pending' | 'charged' | 'failed' | 'waived'
  no_show_fee_cents: number | null
  no_show_fee_charged_at: string | null
  no_show_fee_payment_intent_id: string | null

  // EHR sync (CareStack write-back + Dion Clinical event bus)
  carestack_appointment_id: string | null
  carestack_sync_status: EhrSyncStatus
  dion_sync_status: EhrSyncStatus
  ehr_sync_attempts: number
  ehr_sync_error: string | null

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

// ── SMS Training Console ────────────────────────────────────────

/** Agency-WIDE durable rule authored over SMS. No organization_id — injected
 *  into every practice's live setter/closer prompt via buildAgencyRulesBlock. */
export type AgencyAiRule = {
  id: string
  title: string
  content: string
  category: string
  priority: number
  is_enabled: boolean
  source: string
  created_by: string | null
  created_at: string
  // Review lifecycle for auto-learned rules (null for human-authored rules,
  // which are implicitly approved).
  review_status: 'pending' | 'approved' | 'rejected' | 'retire_flagged' | 'retired' | null
  evidence: AgencyRuleEvidence | null
  approved_by: string | null
  approved_at: string | null
  enabled_at: string | null
  retired_at: string | null
  retirement_reason: string | null
  performance: AgencyRulePerformance | null
}

/** Why an auto-learned candidate rule exists: the code-computed finding plus
 *  real (scrubbed) example exchanges from winning journeys. */
export type AgencyRuleEvidence = {
  finding_key: string
  headline: string
  detail: string
  stats: Record<string, number>
  examples: string[]
}

/** Before/after cohort comparison for a live auto-learned rule. */
export type AgencyRulePerformance = {
  before: { n: number; rate: number }
  after: { n: number; rate: number }
  z: number
  computed_at: string
}

// ── Outcome-Driven Learning Loop ────────────────────────────────

export type LearningOutcome = 'booked' | 'showed' | 'no_show' | 'contract_signed' | 'lost'

/** One step of a lead's communication journey (body truncated + scrubbed). */
export type LearningJourneyEntry = {
  at: string
  role: 'patient' | 'staff' | 'ai'
  channel: string
  body: string
  rule_set_version?: string
}

/** Code-computed features of a journey, used for cohort contrasts. */
export type LearningJourneyStats = {
  inbound_count: number
  outbound_count: number
  ai_outbound_count: number
  ai_share: number
  first_response_minutes: number | null
  median_response_minutes: number | null
  days_span: number
  techniques_used: string[]
  rule_set_versions: string[]
  engagement_first: number | null
  engagement_last: number | null
}

/** A labeled full-journey record: everything that was said to a lead, plus the
 *  real outcome. The training corpus for the weekly distillation pass. */
export type LearningEpisode = {
  id: string
  organization_id: string
  lead_id: string
  outcome: LearningOutcome
  outcome_at: string
  outcome_ref: string
  journey: LearningJourneyEntry[]
  journey_stats: LearningJourneyStats
  message_count: number
  created_at: string
}

/** Audit row for one distillation pass. */
export type LearningRun = {
  id: string
  kind: string
  episode_count: number
  technique_rows: number
  findings: unknown[]
  candidates_created: number
  rules_flagged: number
  error: string | null
  duration_ms: number | null
  created_at: string
}

export type SmsTrainingMode = 'roleplay' | 'dry_run'

/** Per-trainer-phone training state, persisted between stateless webhook hits. */
export type SmsTrainingSession = {
  id: string
  trainer_phone: string
  mode: SmsTrainingMode
  scenario_key: string | null
  patient_persona: Record<string, unknown> | null
  reference_org_id: string | null
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>
  rules_saved: number
  status: 'active' | 'ended'
  started_at: string
  last_activity_at: string
  ended_at: string | null
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

export type ConversationIntent =
  | 'ready_to_book' | 'considering' | 'exploring' | 'resistant' | 'disengaged'
export type ConversationSentiment = 'positive' | 'neutral' | 'mixed' | 'negative'
export type PrimaryObjection =
  | 'cost' | 'financing' | 'fear_anxiety' | 'timing' | 'trust'
  | 'medical' | 'logistics' | 'spouse_approval' | 'none' | 'other'

export type SmartListCriteria = {
  tags?: { ids: string[]; operator: 'and' | 'or' }
  statuses?: string[]
  ai_qualifications?: string[]
  conversation_intents?: ConversationIntent[]
  conversation_sentiments?: ConversationSentiment[]
  primary_objections?: PrimaryObjection[]
  conversation_red_flag?: boolean
  score_min?: number
  score_max?: number
  stages?: string[]
  source_types?: string[]
  engagement_min?: number
  engagement_max?: number
  states?: string[]
  created_after?: string
  created_before?: string
  /** Leads last contacted before this ISO datetime, OR never contacted (null).
   *  Powers "needs follow-up" segments (Pipeline recommendations engine). */
  last_contacted_before?: string
  /** Closer workflow temperature(s), e.g. ['deliberating']. Matches
   *  leads.closing_temperature. */
  closing_temperatures?: string[]
  /** Deliberating deals whose follow-up date has arrived: closing_follow_up_at
   *  IS NOT NULL AND <= this ISO datetime. Powers the "due follow-up" rec. */
  closing_follow_up_before?: string
  /** Only leads that have never been contacted (last_contacted_at is null). */
  never_contacted?: boolean
  has_phone?: boolean
  has_email?: boolean
  sms_consent?: boolean
  email_consent?: boolean
  /** Filter by EHR reconciliation: false = exclude existing patients (new-lead
   *  pools), true = only existing patients. Omit for no filter. */
  is_existing_patient?: boolean
  keywords?: {
    terms: string[]
    match: 'any' | 'all'
    scopes: ('conversation' | 'lead_fields' | 'inbound_sms' | 'tags')[]
  }
  /** Static snapshot: restrict to exactly these lead IDs (max 1000). Powers
   *  SQL-only cohorts (e.g. Action Center queues) that no attribute filter can
   *  express — the cohort is resolved once and pinned. Combines with the other
   *  filters (AND), so consent/contactability criteria still apply on top. */
  lead_ids?: string[]
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
export type VoiceCallReviewStatus = 'pending' | 'clear' | 'flagged' | 'escalated'
export type VoiceCampaignStatus = 'draft' | 'scheduled' | 'active' | 'paused' | 'completed' | 'archived'
export type VoiceCampaignLeadStatus = 'queued' | 'calling' | 'completed' | 'skipped' | 'failed' | 'do_not_call'

// AI-fronted live-agent transfer (bulk dialer that forwards answered calls to a human).
export type VoiceTransferMode = 'immediate' | 'greet_transfer' | 'qualify_transfer'
export type VoiceTransferStatus = 'none' | 'requested' | 'holding' | 'bridged' | 'completed' | 'abandoned' | 'failed'
export type VoiceTransferTargetKind = 'phone' | 'sip' | 'softphone_user'
export type VoiceAgentPresenceStatus = 'available' | 'on_call' | 'offline'

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

  // Post-call AI review (null = call predates the review pipeline)
  review_status: VoiceCallReviewStatus | null
  /** Patient-facing issues the post-call review flagged (CallIssue[] shape). */
  review_flags: Array<Record<string, unknown>> | null

  // Campaign link
  voice_campaign_id: string | null

  // Compliance
  consent_verified: boolean
  recording_disclosure_given: boolean
  tcpa_compliant: boolean

  // Browser softphone (Phase 1): who placed it, how, and the one-time dial token.
  staff_user_id: string | null
  call_mode: 'ai' | 'browser' | 'bridge' | null
  dial_token: string | null

  // Live-agent transfer lifecycle (AI-fronted bulk dialer → human handoff).
  transfer_status: VoiceTransferStatus
  transferred_to_target_id: string | null
  transfer_requested_at: string | null
  transfer_bridged_at: string | null
  /** Seconds the AI held/qualified the live person before a rep picked up (or gave up). */
  hold_seconds: number

  // AI training (admin "use for training" action; null = never submitted)
  training_status: 'processing' | 'added' | 'failed' | null
  training_added_by: string | null
  training_added_at: string | null
  /** The ai_memories / ai_knowledge_articles rows this call produced. */
  training_item_ids: Array<{ type: 'memory' | 'article'; id: string; title: string }>
  training_error: string | null

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

  // Live-agent transfer config (this campaign forwards answered calls to a human).
  live_transfer_enabled: boolean
  transfer_mode: VoiceTransferMode
  /** Burst multiplier: dial (dial_ratio × available reps) at a time. 1.0 = progressive. */
  dial_ratio: number
  /** Per-campaign override of the org hold cap; null = inherit org default. */
  max_hold_seconds: number | null

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

// ── Live-Agent Transfer (AI bulk dialer → human handoff) ────

/** A "live person" an answered call can be forwarded to. */
export type VoiceTransferTarget = {
  id: string
  organization_id: string
  name: string
  kind: VoiceTransferTargetKind
  /** PSTN/SIP destination to <Dial> (for kind 'phone'/'sip'); null for softphone reps. */
  destination: string | null
  /** Staff member whose softphone rings (for kind 'softphone_user'); null otherwise. */
  user_id: string | null
  active: boolean
  on_duty: boolean
  max_concurrent: number
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** Time-of-day routing rule: which targets (in order) receive calls in a window. */
export type VoiceTransferRoute = {
  id: string
  organization_id: string
  name: string
  /** Lower = evaluated first. Overflow rules sit at the end with is_overflow=true. */
  priority: number
  active_days: string[]
  start_hour: number
  end_hour: number
  timezone: string
  /** Ordered voice_transfer_targets ids to try; first available wins. */
  target_ids: string[]
  is_overflow: boolean
  active: boolean
  created_at: string
  updated_at: string
}

/** Live availability of a transfer target (claimed atomically by the broker). */
export type VoiceAgentPresence = {
  id: string
  organization_id: string
  target_id: string
  status: VoiceAgentPresenceStatus
  active_calls: number
  current_call_id: string | null
  last_heartbeat_at: string | null
  updated_at: string
}

// ── Multi-Channel Content Delivery ──────────────────────────

export type ContentAssetType =
  | 'testimonial_video'
  | 'before_after_photo'
  | 'practice_info'
  | 'appointment_details'
  | 'financing_info'
  | 'procedure_info'

export type ContentAsset = {
  id: string
  organization_id: string
  type: ContentAssetType
  title: string
  description: string | null
  content: Record<string, unknown>
  media_urls: string[]
  is_active: boolean
  tags: string[]
  usage_count: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export type CrossChannelDeliveryStatus = 'pending' | 'sent' | 'delivered' | 'failed'

export type CrossChannelDelivery = {
  id: string
  organization_id: string
  lead_id: string
  conversation_id: string
  triggered_by_channel: ConversationChannel
  delivered_via_channel: ConversationChannel
  content_type: ContentAssetType | 'custom_message'
  content_asset_id: string | null
  message_id: string | null
  status: CrossChannelDeliveryStatus
  error_message: string | null
  agent_type: AgentType | null
  tool_name: string | null
  metadata: Record<string, unknown>
  created_at: string
}

// ═══════════════════════════════════════════════════════════════
// TREATMENT CLOSING WORKFLOW
// ═══════════════════════════════════════════════════════════════

export type TreatmentClosingStep =
  | 'treatment_plan_presented'     // Doctor presented plan
  | 'contract_signed'              // Patient signed treatment plan (non-refundable clause)
  | 'financing_funded'             // Loan funded or deposit/payment collected
  | 'consent_signed'               // Consent forms signed
  | 'preop_instructions_sent'      // Pre-op + post-op instructions delivered
  | 'surgery_scheduled'            // Surgery date confirmed with patient
  | 'records_confirmed'            // Records, Rx, availability confirmed by office

export type RecordsChecklist = {
  medical_records: boolean
  dental_records: boolean
  ct_scan: boolean
  prescription_ready: boolean
  surgical_guide_ready: boolean
  lab_work_ordered: boolean
  anesthesia_confirmed: boolean
  surgeon_availability: boolean
}

/**
 * FMR pre-surgical intake bag stored on treatment_closings.intake. Patient-entered
 * fields that feed the Full Mouth Reconstruction contract's merge variables and the
 * conditional smoker consent. See docs/fmr-contract/FMR-Intake-Field-Spec.md.
 */
export type FmrIntake = {
  preferred_pharmacy?: string
  pcp_name?: string
  pcp_phone?: string
  driver_name?: string
  driver_phone?: string
  emergency_contact_name?: string
  emergency_contact_phone?: string
  uses_tobacco_vape_marijuana?: boolean
  preop_date?: string
  discount_amount?: number
}

export type TreatmentClosing = {
  id: string
  lead_id: string | null
  organization_id: string
  clinical_case_id: string | null

  // Step tracking
  current_step: TreatmentClosingStep
  steps_completed: TreatmentClosingStep[]

  // Contract
  contract_signed_at: string | null
  contract_amount: number | null
  deposit_amount: number | null
  deposit_collected_at: string | null
  non_refundable_acknowledged: boolean

  // Financing
  financing_type: 'loan' | 'in_house' | 'cash' | 'insurance' | null
  financing_funded_at: string | null
  financing_monthly_payment: number | null

  // Consent
  consent_signed_at: string | null
  consent_forms: string[]

  // Pre/Post-Op
  preop_instructions_sent_at: string | null
  preop_sent_via: 'sms' | 'email' | 'both' | null
  postop_instructions_sent_at: string | null

  // Surgery
  surgery_date: string | null
  surgery_time: string | null
  surgery_type: string | null
  estimated_duration_hours: number | null

  // Records & Office Confirmation
  records_confirmed_at: string | null
  records_checklist: RecordsChecklist

  // FMR pre-surgical intake (feeds the contract's merge variables)
  intake: FmrIntake

  // Dion Clinical surgery hand-off (federation). Dion Clinical owns the surgery;
  // these are a hand-off receipt + cached read-back for display only.
  dion_handoff_at: string | null
  dion_surgery_status: string | null
  dion_surgery_date: string | null
  dion_synced_at: string | null

  // Metadata
  notes: string | null
  created_at: string
  updated_at: string
}

// ── Clinical Cases ────────────────────────────────────────────

export type CaseStatus =
  | 'intake' | 'analysis' | 'diagnosis' | 'treatment_planning' | 'patient_review'
  // Post-close (closing → surgery) stages
  | 'accepted' | 'closing' | 'surgery_scheduled' | 'ready_for_surgery'
  | 'completed' | 'archived'
export type CasePriority = 'low' | 'normal' | 'high' | 'urgent'
export type CaseFileType = 'photo' | 'xray' | 'panoramic' | 'periapical' | 'cephalometric' | 'cbct' | 'ct_scan' | 'stl' | 'intraoral' | 'extraoral' | 'other'

export type ClinicalCase = {
  id: string
  organization_id: string
  lead_id: string | null
  patient_name: string
  patient_email: string | null
  patient_phone: string | null
  case_number: string
  chief_complaint: string
  clinical_notes: string | null
  status: CaseStatus
  priority: CasePriority
  created_by: string
  assigned_doctor_id: string | null
  ai_analysis_summary: Record<string, unknown> | null
  ai_analyzed_at: string | null
  share_token: string
  patient_notified_at: string | null
  patient_viewed_at: string | null
  patient_accepted_at: string | null
  diagnosed_at: string | null
  treatment_planned_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
  // Joined data
  files?: CaseFile[]
  diagnosis?: CaseDiagnosis | null
  treatment_plan?: CaseTreatmentPlan | null
  creator?: Pick<UserProfile, 'id' | 'full_name' | 'role' | 'avatar_url'>
  assigned_doctor?: Pick<UserProfile, 'id' | 'full_name' | 'role' | 'avatar_url' | 'specialty'> | null
  closing?: Pick<TreatmentClosing,
    'id' | 'current_step' | 'steps_completed' | 'contract_signed_at' | 'contract_amount'
    | 'financing_type' | 'financing_funded_at' | 'consent_signed_at'
    | 'preop_instructions_sent_at' | 'surgery_date' | 'surgery_time'
    | 'records_checklist' | 'records_confirmed_at'
    | 'dion_handoff_at' | 'dion_surgery_status' | 'dion_surgery_date' | 'dion_synced_at'
  > | null
  /** Most relevant lab order (newest non-terminal, else newest). Joined by /api/cases. */
  lab_order?: Pick<LabOrder,
    'id' | 'lab_provider' | 'status' | 'external_case_id' | 'external_case_number'
    | 'submitted_at' | 'updated_at'
  > | null
}

export type CaseFile = {
  id: string
  case_id: string
  organization_id: string
  file_name: string
  file_url: string
  file_size: number | null
  mime_type: string | null
  file_type: CaseFileType
  ai_analysis: Record<string, unknown> | null
  ai_analyzed_at: string | null
  ai_confidence: number | null
  description: string | null
  sort_order: number
  uploaded_by: string | null
  created_at: string
}

export type CaseDiagnosis = {
  id: string
  case_id: string
  organization_id: string
  diagnosis_summary: string
  findings: Array<{ area: string; condition: string; severity: string; notes?: string }>
  icd_codes: string[]
  severity: 'mild' | 'moderate' | 'severe' | 'critical'
  bone_quality: string | null
  soft_tissue_status: string | null
  occlusion_notes: string | null
  risk_factors: string[]
  diagnosed_by: string
  diagnosed_at: string
  created_at: string
  updated_at: string
}

export type CaseTreatmentItem = {
  procedure: string
  description: string
  tooth_numbers?: string[]
  phase: number
  estimated_cost: number
  cdt_code?: string
  notes?: string
}

export type CaseTreatmentPlan = {
  id: string
  case_id: string
  organization_id: string
  plan_summary: string
  total_estimated_cost: number | null
  estimated_duration: string | null
  phases: number
  items: CaseTreatmentItem[]
  alternative_options: Array<{
    name: string
    description: string
    estimated_cost: number
    pros: string[]
    cons: string[]
  }>
  planned_by: string
  approved_at: string | null
  created_at: string
  updated_at: string
}

// ── Lab Orders (records → external lab) ──────────────────────

export type LabOrderStatus =
  | 'draft' | 'submitted' | 'accepted' | 'declined' | 'design_review'
  | 'manufacturing' | 'shipped' | 'delivered' | 'completed' | 'cancelled' | 'error'

export type LabOrder = {
  id: string
  organization_id: string
  clinical_case_id: string
  treatment_closing_id: string | null
  lab_provider: 'smile_design_lab' | 'manual' | 'other'
  external_case_id: string | null
  external_case_number: string | null
  status: LabOrderStatus
  items: Array<{ kind: string; description?: string }>
  files_sent: Array<{ case_file_id: string; file_name: string; file_type: string; sent_at: string }>
  tracking: { carrier?: string; tracking_number?: string; eta?: string }
  status_history: Array<{ from: string | null; to: string; at: string }>
  error: string | null
  submitted_at: string | null
  submitted_by: string | null
  created_at: string
  updated_at: string
}

// ── Pre-Op Instruction Forms ──────────────────────────────────

export type PreopFormStatus = 'draft' | 'sent' | 'viewed' | 'acknowledged' | 'voided'

export type PreopForm = {
  id: string
  organization_id: string
  clinical_case_id: string
  treatment_closing_id: string | null
  title: string
  rendered_html: string
  content: Record<string, unknown>
  status: PreopFormStatus
  share_token: string
  share_token_expires_at: string | null
  sent_via: 'sms' | 'email' | 'both' | null
  sent_at: string | null
  first_viewed_at: string | null
  acknowledged_at: string | null
  acknowledged_name: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

// ── Phase 1 Nurture Foundation (migration 023) ──────────────

export type ConsentChannel = 'sms' | 'email' | 'voice'

export type ConsentLog = {
  id: string
  organization_id: string
  lead_id: string
  channel: ConsentChannel
  consent_given: boolean
  granted_at: string | null
  revoked_at: string | null
  source: string | null
  source_text: string | null
  ip_address: string | null
  user_agent: string | null
  actor_user_id: string | null
  metadata: Record<string, unknown>
  created_at: string
}

export type EventForwarderStatus = 'pending' | 'sent' | 'failed' | 'skipped' | 'na'

export type SystemEvent = {
  id: string
  organization_id: string
  lead_id: string | null
  event_type: string  // 'lead.created' | 'lead.booking.created' | 'lead.dormant.flagged' | 'consent_violation_prevented' | etc.
  payload: Record<string, unknown>
  capi_status: EventForwarderStatus
  capi_attempted_at: string | null
  gads_status: EventForwarderStatus
  gads_attempted_at: string | null
  occurred_at: string
  created_at: string
}

// ── Phase 2 Intelligence Layer (migration 025) ──────────────

export type ReviewSource = 'gbp' | 'yelp' | 'healthgrades' | 'manual'
export type ReviewSentiment = 'positive' | 'neutral' | 'negative'
export type ReviewResponseStatus = 'unresponded' | 'drafted' | 'approved' | 'published' | 'declined'

export type Review = {
  id: string
  organization_id: string
  source: ReviewSource
  external_id: string
  external_url: string | null
  reviewer_name: string | null
  reviewer_avatar_url: string | null
  star_rating: number | null
  review_text: string | null
  reviewed_at: string | null
  sentiment: ReviewSentiment | null
  sentiment_score: number | null
  topics: string[] | null
  sentiment_analyzed_at: string | null
  draft_response: string | null
  draft_response_at: string | null
  draft_model: string | null
  response_status: ReviewResponseStatus
  response_text: string | null
  responded_at: string | null
  responded_by: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type AiUsageFeature =
  | 'summarize'
  | 'personalize'
  | 'score'
  | 'sentiment_review'
  | 'compliance_filter'
  | 'post_call_analysis'
  | 'review_response_draft'

export type AiUsageRow = {
  id: string
  organization_id: string
  lead_id: string | null
  feature: AiUsageFeature
  model: string
  tokens_in: number
  tokens_out: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_cents: number
  billable_cents: number
  duration_ms: number | null
  succeeded: boolean
  error_message: string | null
  metadata: Record<string, unknown>
  occurred_at: string
}

// ── Spend tracking + client re-billing (migration 20260701120000) ──

export type CostEventService = 'sms' | 'voice' | 'email'
export type CostEventStatus = 'estimated' | 'final'

/**
 * Billable ledger for SMS/voice/email. cost_cents = what we pay the provider; billable_cents =
 * what we re-bill the practice (cost × (1 + markup)). AI usage lives in ai_usage, not here.
 */
export type CostEvent = {
  id: string
  organization_id: string
  service: CostEventService
  status: CostEventStatus
  event_at: string
  source_table: string | null
  source_id: string | null
  external_id: string | null
  quantity: number | null
  unit: string | null
  cost_cents: number
  billable_cents: number
  markup_pct: number | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** Per-practice re-billing config. Empty `markups` → platform defaults (src/lib/billing/markup.ts). */
export type BillingSettings = {
  organization_id: string
  markups: Record<string, number>
  platform_fee_cents: number
  notes: string | null
  updated_at: string
}

// ── Phase 3 EHR Integration (migration 026) ─────────────────

export type EhrSource = 'carestack' | 'open_dental' | 'dentrix' | 'eaglesoft' | 'manual'
export type PatientMatchMethod = 'email_hash' | 'phone_hash' | 'name_dob' | 'manual' | 'webhook_meta' | 'unmatched'

export type Patient = {
  id: string
  organization_id: string
  ehr_patient_id: string
  ehr_source: EhrSource
  lead_id: string | null
  match_method: PatientMatchMethod | null
  match_confidence: number | null
  first_name: string | null
  last_name: string | null
  email: string | null
  email_hash: string | null
  phone_e164: string | null
  phone_hash: string | null
  dob: string | null
  default_location_id: number | null
  account_id: number | null
  status: number | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

// CareStack TreatmentPlanStatus enum (also reused for TreatmentProcedure status):
//   1 Proposed | 2 Scheduled | 3 Accepted | 4 Rejected | 5 Alternative |
//   6 Hold    | 7 ReferredOut | 8 Completed | 9 Presented | 10 ServiceCompleted
export type EhrTreatmentStatusId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

export type TreatmentPlan = {
  id: string
  organization_id: string
  patient_id: string
  ehr_treatment_plan_id: number
  ehr_source: EhrSource
  name: string | null
  status_id: EhrTreatmentStatusId
  duration: number | null
  condition_ids: string | null
  coordinator_id: number | null
  total_patient_estimate: number | null
  total_insurance_estimate: number | null
  last_forwarded_status_id: EhrTreatmentStatusId | null
  last_forwarded_at: string | null
  metadata: Record<string, unknown>
  ehr_last_updated_on: string | null
  created_at: string
  updated_at: string
}

export type EhrBusySlot = {
  id: string
  organization_id: string
  ehr_source: EhrSource
  ehr_appointment_id: string
  ehr_patient_id: string | null
  starts_at: string
  ends_at: string
  status: string | null
  appointment_type: string | null
  created_at: string
  updated_at: string
}

export type TreatmentProcedure = {
  id: string
  organization_id: string
  patient_id: string | null
  treatment_plan_id: string | null
  ehr_procedure_id: number
  ehr_source: EhrSource
  ehr_treatment_plan_id: number | null
  ehr_treatment_plan_phase_id: number | null
  ehr_appointment_id: number | null
  ehr_provider_id: number | null
  ehr_location_id: number | null
  procedure_code_id: number | null
  tooth: string | null
  surfaces: Record<string, number> | null
  patient_estimate: number | null
  insurance_estimate: number | null
  status_id: EhrTreatmentStatusId | null
  proposed_date: string | null
  date_of_service: string | null
  is_deleted: boolean
  last_forwarded_status_id: EhrTreatmentStatusId | null
  last_forwarded_at: string | null
  metadata: Record<string, unknown>
  ehr_last_updated_on: string | null
  created_at: string
  updated_at: string
}

export type Invoice = {
  id: string
  organization_id: string
  patient_id: string | null
  ehr_invoice_id: number
  ehr_invoice_number: number | null
  ehr_source: EhrSource
  amount: number
  unapplied_amount: number | null
  ehr_provider_id: number | null
  ehr_location_id: number | null
  payment_category: string | null
  invoice_type: number | null
  invoice_source: number | null
  payment_type_id: number | null
  payment_date: string | null
  is_nsf: boolean
  is_deleted: boolean
  forwarded: boolean
  forwarded_at: string | null
  metadata: Record<string, unknown>
  ehr_last_updated_on: string | null
  created_at: string
  updated_at: string
}

export type EhrSyncResource =
  | 'patients'
  | 'appointments'
  | 'treatment_procedures'
  | 'existing_treatment_procedures'
  | 'invoices'
  | 'accounting_procedures'
  | 'accounting_transactions'
  | 'treatment_plans'
  | 'treatment_phases'
  | 'potential_patients'

export type EhrSyncState = {
  id: string
  organization_id: string
  ehr_source: EhrSource
  resource: EhrSyncResource
  last_synced_at: string | null
  continue_token: string | null
  last_run_at: string | null
  last_run_status: 'success' | 'failed' | 'partial' | null
  last_run_count: number | null
  last_run_error: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

// ── Phase 3 closed-loop attribution (migrations 027-029) ────

export type AdPlatform = 'google_ads' | 'meta_ads' | 'tiktok_ads' | 'youtube_ads' | 'linkedin_ads' | 'other'

export type AdSpendDaily = {
  id: string
  organization_id: string
  date: string
  platform: AdPlatform
  account_id: string | null
  account_name: string | null
  campaign_id: string | null
  campaign_name: string | null
  ad_group_id: string | null
  ad_group_name: string | null
  spend: number
  impressions: number
  clicks: number
  conversions: number | null
  conversion_value: number | null
  cpc: number | null
  cpm: number | null
  ctr: number | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type StripeObjectType = 'payment_intent' | 'invoice' | 'subscription' | 'charge' | 'checkout_session'

export type StripePayment = {
  id: string
  organization_id: string
  stripe_event_id: string
  stripe_object_id: string
  stripe_object_type: StripeObjectType
  stripe_customer_id: string | null
  stripe_account_id: string | null
  amount_cents: number
  amount: number
  currency: string
  email: string | null
  email_hash: string | null
  phone: string | null
  phone_hash: string | null
  lead_id: string | null
  patient_id: string | null
  match_method: 'email_hash' | 'phone_hash' | 'manual' | 'webhook_meta' | 'unmatched' | null
  financing_partner: string | null
  forwarded: boolean
  forwarded_at: string | null
  status: string | null
  occurred_at: string
  metadata: Record<string, unknown>
  raw_payload: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export type ExpenseCategory = 'acquisition' | 'platform' | 'other'

export type ExpenseLineItem = {
  id: string
  organization_id: string
  source: 'brex' | 'manual'
  external_id: string
  posted_at: string
  amount_cents: number
  amount: number
  currency: string
  vendor_name: string | null
  vendor_normalized: string | null
  description: string | null
  card_last4: string | null
  user_email: string | null
  category: ExpenseCategory
  subcategory: string | null
  category_overridden: boolean
  metadata: Record<string, unknown>
  raw_payload: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

// ────────────────────────────────────────────────────────────────
// AI-Generated Patient Treatment Contracts
// ────────────────────────────────────────────────────────────────

export type ContractSectionKind = 'boilerplate' | 'ai_narrative' | 'data_table' | 'consent' | 'signature'
export type ContractTemplateDataSource = 'treatment_plan.phases' | 'financial.summary'

export type ContractTemplateSection = {
  id: string
  title: string
  kind: ContractSectionKind
  required: boolean
  body?: string
  ai_prompt?: string
  max_ai_words?: number
  consent_key?: string
  data_source?: ContractTemplateDataSource
}

export type ContractTemplate = {
  id: string
  organization_id: string
  name: string
  slug: string
  version: number
  sections: ContractTemplateSection[]
  required_variables: string[]
  status: 'draft' | 'published' | 'archived'
  published_at: string | null
  published_by: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export type ContractStatus =
  | 'draft'
  | 'pending_review'
  | 'changes_requested'
  | 'approved'
  | 'sent'
  | 'viewed'
  | 'signed'
  | 'executed'
  | 'declined'
  | 'expired'
  | 'voided'

export type RenderedContractSection = {
  section_id: string
  title: string
  kind: ContractSectionKind
  rendered_text: string
  rendered_html: string
  ai_generated: boolean
  consent_key?: string
  data_source?: ContractTemplateDataSource
  data_rows?: Array<Record<string, string | number>>
}

export type ContractConsentAgreement = {
  section_id: string
  consent_key: string
  agreed_at: string
}

export type PatientContract = {
  id: string
  organization_id: string
  clinical_case_id: string
  lead_id: string | null
  treatment_closing_id: string | null
  case_treatment_plan_id: string | null

  template_id: string | null
  template_version: number
  template_snapshot: { sections: ContractTemplateSection[]; name?: string; slug?: string }

  generated_content: RenderedContractSection[]
  context_snapshot: Record<string, unknown>

  status: ContractStatus
  needs_manual_draft: boolean

  reviewer_id: string | null
  review_notes: string | null
  reviewed_at: string | null
  approved_at: string | null

  share_token: string
  share_token_expires_at: string | null
  sent_at: string | null
  sent_via: 'email' | 'sms' | 'email+sms' | 'portal_only' | null
  first_viewed_at: string | null

  signed_at: string | null
  signer_name: string | null
  signer_ip: string | null
  signer_user_agent: string | null
  signature_data_url: string | null
  signature_type: 'drawn' | 'typed' | null
  consents_agreed: ContractConsentAgreement[]

  draft_pdf_storage_path: string | null
  executed_pdf_storage_path: string | null
  executed_pdf_sha256: string | null

  contract_amount: number | null
  deposit_amount: number | null
  financing_type: 'loan' | 'in_house' | 'cash' | 'insurance' | null
  financing_monthly_payment: number | null

  ai_model: string | null
  ai_tokens_in: number | null
  ai_tokens_out: number | null
  ai_cost_cents: number | null

  created_by: string | null
  created_at: string
  updated_at: string
}

export type ContractEvent = {
  id: string
  organization_id: string
  contract_id: string
  event_type: string
  actor_type: 'user' | 'patient' | 'system' | 'ai_agent'
  actor_id: string | null
  payload: Record<string, unknown>
  created_at: string
}

export type OrgLegalSettings = {
  entity_name: string | null
  state_of_formation: string | null
  license_numbers: Record<string, string>
  principal_address: { street: string; city: string; state: string; zip: string } | null
  attorney_contact: { name: string; email: string; phone: string } | null
  arbitration_venue: string | null
  cancellation_policy_days: number
  refund_policy_days: number
  governing_law: string | null
  esign_disclosure_version: string
}

export type OrgContractSettings = {
  signature_type_allowed: ('drawn' | 'typed')[]
  send_method_default: 'email' | 'sms' | 'email+sms' | 'portal_only'
  share_token_expiry_days: number
  auto_draft_on_ehr_accept: boolean
}

// ─── Automation allocation policies (Workstream D1) ────────────────────────

export type AutomationPolicyScope = 'org_default' | 'campaign' | 'stage' | 'segment'
export type AutomationPolicyOwner = 'ai' | 'human' | 'hybrid'

/** Row of automation_policies — who owns an automation touch (AI/human/hybrid). */
export type AutomationPolicy = {
  id: string
  organization_id: string
  scope: AutomationPolicyScope
  campaign_id: string | null
  voice_campaign_id: string | null
  stage_id: string | null
  smart_list_id: string | null
  /** AllocationKind values; empty array = policy applies to all kinds. */
  kinds: string[]
  owner: AutomationPolicyOwner
  ai_role: 'setter' | 'closer' | null
  /** WeekSchedule shape (see lib/autopilot/config). Enabled hours = HUMAN hours. */
  human_schedule: Record<string, unknown> | null
  human_first: boolean
  human_response_sla_seconds: number
  enabled: boolean
  created_at: string
  updated_at: string
}

// ─── Outreach sequences (command-center-editable cadences) ──────────────────

export type SequenceTrigger = 'lead_created' | 'appointment'
export type SequenceAnchor = 'enrollment' | 'appointment_time'
export type SequenceStepChannel = 'sms' | 'email' | 'ai_call' | 'human_call' | 'human_task'
export type SequenceStepOwner = 'ai' | 'human'
export type SequenceStepCondition = 'always' | 'unconfirmed' | 'confirmed'
export type SequenceStepKind = 'step' | 'speed_to_lead'

/** Row of outreach_sequences. */
export type OutreachSequence = {
  id: string
  organization_id: string
  key: string
  name: string
  description: string | null
  trigger: SequenceTrigger
  anchor: SequenceAnchor
  enabled: boolean
  is_system: boolean
  stop_on_reply: boolean
  stop_on_booking: boolean
  created_at: string
  updated_at: string
}

/** Row of outreach_sequence_steps. */
export type OutreachSequenceStep = {
  id: string
  organization_id: string
  sequence_id: string
  position: number
  /** Minutes relative to the anchor; negative = before the appointment. */
  offset_minutes: number
  channel: SequenceStepChannel
  owner: SequenceStepOwner
  condition: SequenceStepCondition
  intent: string | null
  template_subject: string | null
  template_body: string | null
  enabled: boolean
  kind: SequenceStepKind
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

// ═══════════════════════════════════════════════════════════════
// AI IMPROVEMENT TICKETS — engineering-facing findings raised by the
// post-call review (and deterministic system checks), surfaced in the
// Agency admin panel at /agency/ai-improvements.
// ═══════════════════════════════════════════════════════════════

export type AIImprovementTicketStatus = 'open' | 'acknowledged' | 'in_progress' | 'resolved' | 'dismissed'
export type AIImprovementTicketSeverity = 'critical' | 'warning' | 'info'
export type AIImprovementTicketCategory = 'agent_logic' | 'prompt' | 'telephony' | 'data_gap' | 'integration' | 'other'

/** Row of ai_improvement_tickets. */
export type AIImprovementTicket = {
  id: string
  organization_id: string | null
  source: 'post_call_review' | 'system_check'
  category: AIImprovementTicketCategory
  severity: AIImprovementTicketSeverity
  title: string
  summary: string | null
  recommendation: string | null
  /** Ordered concrete remediation steps proposed by the reviewer. */
  action_plan: string[]
  /** Pointers back to the triggering call(s): call_ids, retell_call_id, … */
  evidence: Record<string, unknown>
  fingerprint: string
  occurrence_count: number
  last_seen_at: string
  status: AIImprovementTicketStatus
  resolution_note: string | null
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}
