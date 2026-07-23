/**
 * Agent Tools — Function Calling for AI Agents
 *
 * Defines tools that Claude can call during conversations to take
 * real actions: check appointment availability, create bookings,
 * send financing links, and cross-channel content delivery.
 *
 * Cross-channel tools enable the AI to send SMS/email from any channel:
 * - send_sms_to_lead: Send a custom SMS message
 * - send_email_to_lead: Send a custom email
 * - send_practice_info: Send practice address/hours/directions
 * - send_testimonial: Send a patient testimonial video/story
 * - send_before_after: Send before/after transformation photos
 *
 * These tools are injected into the Anthropic API call as tool definitions.
 * When Claude returns a tool_use block, we execute the tool and continue.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getAgentIdForRole } from '@/lib/agents/agent-resolver'
import { generateAvailableSlots, formatTimeDisplay, type BookingConfig, type ExistingAppointment } from '@/lib/booking/availability'
import { zonedTimeToUtc } from '@/lib/booking/timezone'
import { syncAppointmentToEhr } from '@/lib/booking/ehr-sync'
import { fetchEhrBusyAsAppointments } from '@/lib/booking/ehr-busy'
import { isCallGateEnabled, hasQualifyingCall } from '@/lib/booking/call-gate'
import { sendCardCaptureLink } from '@/lib/stripe/no-show-fee'
import { encryptLeadPII } from '@/lib/encryption'
import { sendSMSToLead } from '@/lib/messaging/twilio'
import { sendEmail } from '@/lib/messaging/resend'
import { decryptField } from '@/lib/encryption'
import { verifyDob } from '@/lib/ai/identity-verification'
import { auditPHIWrite, auditPHITransmission } from '@/lib/hipaa-audit'
import { getAssetsByType, getRandomAssets, getPracticeInfo, incrementUsage, recordDelivery } from '@/lib/content/practice-assets'
import { formatAssetForSMS, formatAssetForEmail, formatCustomSMS, formatCustomEmail } from '@/lib/content/delivery-templates'
import { resolveBrandIdentity } from '@/lib/branding/prompt-block'
import { getTreatmentClosing, getClosingProgress, advanceStep } from '@/lib/treatment/treatment-closing'
import { getOrCreateFinancingShareLink } from '@/lib/financing/share-link'
import { buildQualificationStatus, isDiscoveryComplete } from '@/lib/ai/agent-types'
import { escapeHtml } from '@/lib/utils'
import { logger } from '@/lib/logger'
import { executeStageTransition } from '@/lib/funnel/executor'
import { ensureContractDraftForCase } from '@/lib/contracts/orchestrator'
import type { Lead, LeadStatus } from '@/types/database'
import type Anthropic from '@anthropic-ai/sdk'

// ═══════════════════════════════════════════════════════════
// AGENT-DRIVABLE PIPELINE TRANSITIONS
// ═══════════════════════════════════════════════════════════
//
// The agent may only move a lead FORWARD through engagement/sales stages it
// can legitimately infer from the conversation. Everything else is deliberately
// off-limits: booking (create_booking owns consultation_scheduled), contracts
// (contract tooling owns contract_sent/signed), clinical states
// (scheduled/in_treatment/completed), and negative outcomes
// (lost/disqualified/no_show — a human or the disqualify cron decides those).
// A stale allow-list is safer than an agent that can silently mark a lead
// "completed" or "lost".
export const AGENT_STAGE_TRANSITIONS: Partial<Record<LeadStatus, LeadStatus[]>> = {
  new: ['contacted', 'qualified'],
  contacted: ['qualified'],
  consultation_completed: ['treatment_presented', 'financing'],
  treatment_presented: ['financing'],
}

/** Pure guard: may the agent move a lead from `from` to `to` on its own? */
export function isAgentStageTransitionAllowed(from: LeadStatus, to: LeadStatus): boolean {
  if (from === to) return false
  return (AGENT_STAGE_TRANSITIONS[from] ?? []).includes(to)
}

// ═══════════════════════════════════════════════════════════
// TOOL DEFINITIONS (sent to Claude)
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// CROSS-CHANNEL TOOL DEFINITIONS (shared by Setter & Closer)
// ═══════════════════════════════════════════════════════════

const CROSS_CHANNEL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'verify_identity',
    description: 'Confirm the person you are talking to really is this patient BEFORE sharing any appointment time, treatment plan, financing, or insurance detail. Ask them for their date of birth, then call this with exactly what they said. Returns whether it matched what is on file. Only discuss case-specific details after this returns verified. If it does not match, do not share details — offer to have a team member call them back at the number on file. You may still greet them by first name, answer general questions, and book a consultation without verifying.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date_of_birth: {
          type: 'string',
          description: 'The date of birth the patient stated, in whatever format they gave it (e.g. "March 5 1980", "3/5/1980").',
        },
      },
      required: ['date_of_birth'],
    },
  },
  {
    name: 'send_sms_to_lead',
    description: 'Send a custom SMS text message to the patient from a DIFFERENT channel — e.g., text them a link or address while on a phone call, or while emailing. Do NOT use this in an SMS conversation: there, your reply IS the text message, so put the content (links included) directly in your reply instead of calling this tool.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'The SMS message to send. Keep it under 300 characters. Be concise and include any relevant links or details.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'send_email_to_lead',
    description: 'Send a custom email to the patient. Use this when the patient asks for detailed information via email, or when you need to send something that benefits from rich formatting (images, detailed text). Works from any channel.',
    input_schema: {
      type: 'object' as const,
      properties: {
        subject: {
          type: 'string',
          description: 'The email subject line.',
        },
        message: {
          type: 'string',
          description: 'The email body content. Can be longer and more detailed than SMS.',
        },
      },
      required: ['subject', 'message'],
    },
  },
  {
    name: 'send_practice_info',
    description: 'Send the practice\'s address, phone number, hours, and directions to the patient. Use when they ask "where are you located?", "what\'s the address?", "how do I get there?", or any location-related question. Sends via SMS by default, or email if specified.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          enum: ['sms', 'email'],
          description: 'Which channel to send via. Default is SMS.',
        },
      },
      required: [],
    },
  },
  {
    name: 'send_testimonial',
    description: 'Send a patient testimonial video or story to the patient. Use when they ask about reviews, patient experiences, success stories, or want social proof. Sends via SMS (with video link) or email (with embedded thumbnail).',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          enum: ['sms', 'email'],
          description: 'Which channel to send via. Default is SMS for quick video link, email for richer presentation.',
        },
      },
      required: [],
    },
  },
  {
    name: 'send_before_after',
    description: 'Send before-and-after transformation photos to the patient. Use when they ask to see results, transformations, or examples of work. Email is preferred (can embed images), SMS sends a link to the photo gallery.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          enum: ['sms', 'email'],
          description: 'Which channel to send via. Default is email for image embeds.',
        },
      },
      required: [],
    },
  },
  {
    name: 'advance_lead_stage',
    description: 'Move the patient FORWARD in the sales pipeline to record real progress you observe in the conversation. Set "contacted" once you have genuinely engaged them; "qualified" once they clearly meet the criteria (interested, a viable candidate, and the decision-maker); "treatment_presented" once you have walked them through the treatment plan; "financing" once the conversation has moved to how they will pay. Do NOT use this to book consultations (use create_booking) or to send/sign contracts (handled separately). Only ever move forward, and only when it is genuinely true — this drives the practice\'s pipeline and reporting.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to_stage: {
          type: 'string',
          enum: ['contacted', 'qualified', 'treatment_presented', 'financing'],
          description: 'The stage the patient has genuinely reached based on the conversation.',
        },
        reason: {
          type: 'string',
          description: 'One short sentence: what in the conversation shows the patient reached this stage.',
        },
      },
      required: ['to_stage'],
    },
  },
]

export const SETTER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_availability',
    description: 'Check available appointment slots for the next 2 weeks. Call this when a patient expresses interest in scheduling or asks about availability.',
    input_schema: {
      type: 'object' as const,
      properties: {
        preferred_day: {
          type: 'string',
          description: 'Optional preferred day of week (e.g., "monday", "tuesday"). Leave empty to get all available days.',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_booking',
    description: 'Book a consultation appointment for the patient. Call this after the patient has confirmed a date and time. The practice\'s records system needs the patient\'s date of birth to register the appointment — if it is not already on file, ask for it when confirming the booking and pass it as date_of_birth.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'The appointment date in YYYY-MM-DD format.',
        },
        time: {
          type: 'string',
          description: 'The appointment time in HH:MM format (24-hour).',
        },
        date_of_birth: {
          type: 'string',
          description: 'The patient\'s date of birth in YYYY-MM-DD format, needed to register the appointment in the practice\'s records system. Ask for it when confirming the booking (skip if already on file). If the patient declines to share it, pass "declined" and staff will collect it at the visit.',
        },
      },
      required: ['date', 'time'],
    },
  },
  ...CROSS_CHANNEL_TOOLS,
]

export const CLOSER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'check_financing_status',
    description: 'Check the patient\'s financing pre-approval status and available payment options.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'send_financing_link',
    description: 'Send the patient a link to apply for financing. Only call this when they express interest in payment options.',
    input_schema: {
      type: 'object' as const,
      properties: {
        treatment_value: {
          type: 'number',
          description: 'Optional estimated treatment value in dollars.',
        },
      },
      required: [],
    },
  },
  {
    name: 'check_closing_progress',
    description: 'Check where the patient is in the treatment closing workflow (contract → financing → consent → pre-op → surgery → records). Use this to know what step comes next.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'send_preop_instructions',
    description: 'Send pre-operative and post-operative care instructions to the patient via SMS, email, or both. Use this after consent forms are signed and before surgery.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: {
          type: 'string',
          enum: ['sms', 'email', 'both'],
          description: 'Channel to deliver pre-op instructions. Default: both.',
        },
      },
      required: [],
    },
  },
  {
    name: 'schedule_follow_up_consultation',
    description: 'Schedule a follow-up consultation for a patient who hasn\'t committed after their initial consultation. This is a re-close opportunity — a second visit to address remaining concerns.',
    input_schema: {
      type: 'object' as const,
      properties: {
        preferred_day: {
          type: 'string',
          description: 'Preferred day of the week (e.g., "monday", "friday").',
        },
        consultation_type: {
          type: 'string',
          enum: ['in_person', 'virtual', 'phone'],
          description: 'Type of follow-up consultation.',
        },
      },
      required: [],
    },
  },
  {
    name: 'check_contract_status',
    description: 'Check whether this patient has a treatment contract yet and where it stands (no clinical case yet, draft, awaiting review, approved, sent, viewed, signed, or executed). Call this before discussing paperwork so you say the right thing.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'prepare_contract_draft',
    description: 'Prepare the patient\'s treatment contract DRAFT once they have verbally agreed to move forward (and a clinical case / treatment plan exists). This creates a draft for a human team member to review, approve, and send — it does NOT send, sign, or execute anything itself. Use it to get the paperwork moving the moment the patient commits, then tell them the team will send it over shortly.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  ...CROSS_CHANNEL_TOOLS,
]

// ═══════════════════════════════════════════════════════════
// TOOL EXECUTOR
// ═══════════════════════════════════════════════════════════

export type ToolResult = {
  success: boolean
  data: Record<string, unknown>
  message: string // Human-readable summary for the AI
}

/**
 * Tools that surface the patient's OWN case data. Blocked until the conversation
 * is identity-verified (context.disclose_phi !== false). Action-only tools
 * (check_availability, create_booking) stay open — they don't disclose existing
 * PHI, and the model has none in context to leak while unverified.
 */
const PHI_GATED_TOOLS: ReadonlySet<string> = new Set([
  'check_financing_status',
  'check_closing_progress',
  'check_contract_status',
  'prepare_contract_draft',
  'send_preop_instructions',
])

/**
 * Tools that are SAFE to run during a preview/dry-run (task delegation): pure
 * read-only lookups with no patient-facing effect. Anything not on this
 * allowlist is refused in preview (see executeAgentTool) — allowlist, not
 * denylist, so a newly added tool is treated as unsafe until vetted rather than
 * silently firing during a preview. (`verify_identity` writes the conversation's
 * verified flag, so it is deliberately excluded.)
 */
const PREVIEW_SAFE_TOOLS: ReadonlySet<string> = new Set([
  'check_availability',
  'check_financing_status',
  'check_closing_progress',
  'check_contract_status',
])

/**
 * verify_identity — compare the caller's stated DOB against the encrypted DOB on
 * file and, on a match, mark the conversation verified for the TTL window.
 */
async function executeVerifyIdentity(
  supabase: SupabaseClient,
  context: { conversation_id: string; lead: Record<string, unknown> },
  claimedDob: string,
): Promise<ToolResult> {
  const matched = verifyDob(claimedDob, context.lead.date_of_birth as string | null | undefined)
  if (!matched) {
    return {
      success: false,
      data: { verified: false },
      message: 'The date of birth did not match our records. Do NOT share any appointment, treatment, financing, or insurance details. Politely ask them to confirm their date of birth once more; if it still does not match, offer to have a team member call them back at the number on file.',
    }
  }
  await supabase
    .from('conversations')
    .update({ identity_verified_at: new Date().toISOString(), identity_verified_via: 'dob' })
    .eq('id', context.conversation_id)
  return {
    success: true,
    data: { verified: true },
    message: 'Identity verified via date of birth. You may now discuss this patient\'s appointment, treatment, and financing details for the remainder of this conversation.',
  }
}

/**
 * Execute a tool call from the AI agent.
 */
export async function executeAgentTool(
  supabase: SupabaseClient,
  toolName: string,
  toolInput: Record<string, unknown>,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string // The current channel the agent is on
    agent_role?: 'setter' | 'closer' // Attributes downstream message inserts
    disclose_phi?: boolean // HIPAA gate: false until identity is verified
    preview?: boolean // Dry-run: refuse all side-effecting tools (see below)
  }
): Promise<ToolResult> {
  // Preview/dry-run gate (task delegation): the model is drafting a reply for a
  // human to review, not actually replying. Only read-only lookups may run;
  // every side-effecting tool is refused so nothing reaches the patient and no
  // state is mutated before the human hits Send. The refusal is phrased to make
  // the model INLINE the information into its written reply rather than claim it
  // sent something separately — otherwise the delegated reply could read
  // "Sent! Check your messages" for a message that was never sent.
  if (context.preview === true && !PREVIEW_SAFE_TOOLS.has(toolName)) {
    return {
      success: false,
      data: { preview: true },
      message:
        'Preview mode: outbound actions (texts, emails, bookings, stage changes) ' +
        'are disabled while a teammate reviews your reply. Do NOT say you sent or ' +
        'scheduled anything. Instead, put any address, link, or detail directly ' +
        'into your written reply so it is self-contained.',
    }
  }

  // HIPAA gate: tools that surface the patient's own case data are blocked until
  // identity is verified. This is enforcement in code — it holds even if the
  // model ignores the prompt. verify_identity itself is always allowed.
  if (context.disclose_phi === false && PHI_GATED_TOOLS.has(toolName)) {
    return {
      success: false,
      data: { requires_verification: true },
      message: 'Identity not verified. Before sharing this patient\'s appointment, treatment, financing, or insurance details, ask for their date of birth and call verify_identity. If it cannot be verified, offer a callback from a team member.',
    }
  }

  const result = await dispatchAgentTool(supabase, toolName, toolInput, context)

  // Double-text guard: when a content-send tool delivered on the SAME channel
  // the conversation is already on, the patient just received that content as
  // its own message. Flag it so the agent can suppress its now-redundant final
  // reply (see the suppress_final_message logic in the agents). Cross-channel
  // sends (voice call → SMS, SMS → email) are NOT flagged — there the separate
  // send is exactly the point.
  const deliveryChannel = sameChannelSendChannel(toolName, toolInput)
  if (deliveryChannel && result.success && deliveryChannel === (context.channel || 'sms')) {
    result.data = { ...(result.data as Record<string, unknown>), same_channel_delivery: true }
  }
  return result
}

/**
 * The delivery channel a content-send tool uses, or null if the tool isn't a
 * content send. Used to detect same-channel double-texting.
 */
function sameChannelSendChannel(
  toolName: string,
  toolInput: Record<string, unknown>
): 'sms' | 'email' | null {
  switch (toolName) {
    case 'send_sms_to_lead':
    case 'send_financing_link':
      return 'sms'
    case 'send_email_to_lead':
      return 'email'
    case 'send_practice_info':
    case 'send_testimonial':
      return (toolInput.channel as string) === 'email' ? 'email' : 'sms'
    case 'send_before_after':
      return (toolInput.channel as string) === 'sms' ? 'sms' : 'email'
    default:
      return null
  }
}

async function dispatchAgentTool(
  supabase: SupabaseClient,
  toolName: string,
  toolInput: Record<string, unknown>,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
    agent_role?: 'setter' | 'closer'
    disclose_phi?: boolean
  }
): Promise<ToolResult> {
  switch (toolName) {
    case 'verify_identity':
      return executeVerifyIdentity(supabase, context, toolInput.date_of_birth as string)

    case 'check_availability':
      return executeCheckAvailability(supabase, context.organization_id, toolInput.preferred_day as string | undefined, context.lead_id)

    case 'create_booking':
      return executeCreateBooking(supabase, context, toolInput.date as string, toolInput.time as string, toolInput.date_of_birth as string | undefined)

    case 'check_financing_status':
      return executeCheckFinancingStatus(supabase, context.lead_id)

    case 'send_financing_link':
      return executeSendFinancingLink(supabase, context, toolInput.treatment_value as number | undefined)

    // Cross-channel tools
    case 'send_sms_to_lead':
      return executeSendSMSToLead(supabase, context, toolInput.message as string)

    case 'send_email_to_lead':
      return executeSendEmailToLead(supabase, context, toolInput.subject as string, toolInput.message as string)

    case 'send_practice_info':
      return executeSendPracticeInfo(supabase, context, (toolInput.channel as string) || 'sms')

    case 'send_testimonial':
      return executeSendTestimonial(supabase, context, (toolInput.channel as string) || 'sms')

    case 'send_before_after':
      return executeSendBeforeAfter(supabase, context, (toolInput.channel as string) || 'email')

    // Treatment closing tools
    case 'check_closing_progress':
      return executeCheckClosingProgress(supabase, context.lead_id)

    case 'send_preop_instructions':
      return executeSendPreopInstructions(supabase, context, (toolInput.channel as string) || 'both')

    case 'schedule_follow_up_consultation':
      return executeScheduleFollowUp(supabase, context, toolInput.preferred_day as string | undefined, (toolInput.consultation_type as string) || 'in_person')

    case 'advance_lead_stage':
      return executeAdvanceLeadStage(supabase, context, toolInput.to_stage as string, toolInput.reason as string | undefined)

    case 'check_contract_status':
      return executeCheckContractStatus(supabase, context)

    case 'prepare_contract_draft':
      return executePrepareContractDraft(supabase, context)

    default:
      return { success: false, data: {}, message: `Unknown tool: ${toolName}` }
  }
}

// ═══════════════════════════════════════════════════════════
// TOOL IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════

/**
 * Move a lead forward in the pipeline on the agent's own initiative, gated by
 * the AGENT_STAGE_TRANSITIONS whitelist. Records an activity and fires the
 * existing funnel automations for the transition (best-effort).
 */
async function executeAdvanceLeadStage(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
  },
  toStage: string,
  reason?: string
): Promise<ToolResult> {
  const to = toStage as LeadStatus

  // Read the current stage fresh — context.lead may be stale mid-conversation.
  const { data: current } = await supabase
    .from('leads')
    .select('status')
    .eq('id', context.lead_id)
    .single()

  const from = (current?.status ?? context.lead.status) as LeadStatus | undefined
  if (!from) {
    return { success: false, data: {}, message: 'Could not determine the patient\'s current pipeline stage.' }
  }

  if (from === to) {
    return { success: false, data: { from, to }, message: `The patient is already at the "${to}" stage.` }
  }

  if (!isAgentStageTransitionAllowed(from, to)) {
    const allowed = AGENT_STAGE_TRANSITIONS[from] ?? []
    const guidance = allowed.length
      ? `From "${from}" you may only advance to: ${allowed.join(', ')}.`
      : `You cannot change the stage from "${from}" yourself — booking, contracts, and outcomes are handled by dedicated tools or a human.`
    return { success: false, data: { from, to, allowed }, message: `Not allowed. ${guidance}` }
  }

  const { error } = await supabase
    .from('leads')
    .update({ status: to })
    .eq('id', context.lead_id)

  if (error) {
    return { success: false, data: {}, message: 'Failed to update the pipeline stage. Please try again.' }
  }

  await supabase.from('lead_activities').insert({
    organization_id: context.organization_id,
    lead_id: context.lead_id,
    activity_type: 'stage_advanced',
    title: `AI advanced stage: ${from} → ${to}`,
    metadata: {
      from,
      to,
      reason: reason || null,
      source: 'ai_agent',
      conversation_id: context.conversation_id,
    },
  })

  // Fire funnel automations for the transition (best-effort — a failure here
  // must not undo the stage change the agent legitimately made).
  let automationsExecuted = 0
  try {
    const results = await executeStageTransition(supabase, {
      organizationId: context.organization_id,
      leadId: context.lead_id,
      lead: { ...context.lead, status: to },
      fromStageSlug: from,
      toStageSlug: to,
    })
    automationsExecuted = results.reduce((n, r) => n + r.actionsExecuted, 0)
  } catch {
    // Automations are non-critical to the stage transition itself.
  }

  return {
    success: true,
    data: { from, to, automationsExecuted },
    message: `Advanced the patient from "${from}" to "${to}".${automationsExecuted ? ` Triggered ${automationsExecuted} follow-up action(s).` : ''}`,
  }
}

/** Most-recent clinical case for the lead, or null. Contracts hang off cases. */
async function resolveLeadCase(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string
): Promise<{ id: string; status: string; patient_accepted_at: string | null } | null> {
  const { data } = await supabase
    .from('clinical_cases')
    .select('id, status, patient_accepted_at, created_at')
    .eq('organization_id', organizationId)
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { id: string; status: string; patient_accepted_at: string | null } | null) ?? null
}

const CONTRACT_STATUS_PHRASING: Record<string, string> = {
  draft: 'in draft (not yet reviewed by the team)',
  pending_review: 'awaiting the team\'s review',
  changes_requested: 'being revised by the team',
  approved: 'approved and ready to send',
  sent: 'sent to the patient to sign',
  viewed: 'opened by the patient, not yet signed',
  signed: 'signed by the patient',
  executed: 'fully executed',
  declined: 'declined',
  expired: 'expired',
  voided: 'voided',
}

/** Read-only: tell the agent where this patient's contract stands. */
async function executeCheckContractStatus(
  supabase: SupabaseClient,
  context: { organization_id: string; lead_id: string }
): Promise<ToolResult> {
  const kase = await resolveLeadCase(supabase, context.organization_id, context.lead_id)
  if (!kase) {
    return {
      success: true,
      data: { has_case: false, has_contract: false },
      message: 'There is no clinical case for this patient yet, so no contract exists. A treatment plan/case has to be created by the team before a contract can be prepared.',
    }
  }

  const { data: contract } = await supabase
    .from('patient_contracts')
    .select('id, status')
    .eq('organization_id', context.organization_id)
    .eq('clinical_case_id', kase.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; status: string }>()

  if (!contract) {
    return {
      success: true,
      data: { has_case: true, has_contract: false, case_status: kase.status },
      message: `There is a clinical case (status: ${kase.status}) but no contract has been prepared yet. Once the patient agrees to proceed you can prepare a draft.`,
    }
  }

  return {
    success: true,
    data: { has_case: true, has_contract: true, status: contract.status },
    message: `The treatment contract is ${CONTRACT_STATUS_PHRASING[contract.status] ?? contract.status}.`,
  }
}

/**
 * Create the patient's contract DRAFT (agent-initiated) once they commit.
 * Deliberately stops at the draft: approval and sending remain a human,
 * permission-gated action — the agent never autonomously executes a legal
 * document. Closes the "agent can't move toward the close" gap safely.
 */
async function executePrepareContractDraft(
  supabase: SupabaseClient,
  context: { organization_id: string; lead_id: string }
): Promise<ToolResult> {
  const kase = await resolveLeadCase(supabase, context.organization_id, context.lead_id)
  if (!kase) {
    return {
      success: false,
      data: { has_case: false },
      message: 'Can\'t prepare a contract yet — there is no clinical case/treatment plan for this patient. Let them know the team will set up their treatment plan first, then send the agreement.',
    }
  }

  const result = await ensureContractDraftForCase({
    supabase,
    organizationId: context.organization_id,
    caseId: kase.id,
    actorType: 'ai_agent',
    actorId: null,
  })

  if (!result.ok) {
    const message =
      result.code === 'missing_legal'
        ? 'I couldn\'t prepare the contract because the practice\'s legal/contract settings are incomplete. A team member will handle the paperwork.'
        : result.code === 'no_template'
          ? 'I couldn\'t prepare the contract because no contract template is published for this practice yet. A team member will follow up with the agreement.'
          : result.code === 'already_in_progress'
            ? 'A contract is already being prepared for this patient — the team will send it shortly.'
            : result.code === 'case_not_found'
              ? 'I couldn\'t locate the patient\'s case to prepare the contract; a team member will follow up.'
              : 'I couldn\'t prepare the contract right now, but a team member will follow up with the agreement.'
    return { success: false, data: { code: result.code, missing: result.missing ?? [] }, message }
  }

  return {
    success: true,
    data: { contract_id: result.contract_id, status: result.status, needs_manual_draft: result.needs_manual_draft },
    message: result.needs_manual_draft
      ? 'I\'ve started the contract, but a team member needs to finish drafting it. Tell the patient the team will send their agreement over shortly.'
      : `I've prepared the patient's contract draft. A team member will review and send it for signature — tell the patient to expect it soon.`,
  }
}

async function executeCheckAvailability(
  supabase: SupabaseClient,
  organizationId: string,
  preferredDay?: string,
  leadId?: string
): Promise<ToolResult> {
  // Backstop for the "already booked" state: if this patient has a live upcoming
  // consultation, do NOT surface open slots. Re-offering availability here is
  // exactly what made the setter contradict a time it had already confirmed.
  if (leadId) {
    const { getActiveUpcomingAppointment } = await import('@/lib/appointments/upcoming')
    const existing = await getActiveUpcomingAppointment(supabase, organizationId, leadId).catch(() => null)
    if (existing) {
      return {
        success: false,
        data: { already_booked: true, scheduled_at: existing.scheduled_at },
        message:
          'This patient already has a confirmed consultation on the books. Do NOT offer new appointment times. ' +
          'Confirm their existing time back to them (see the ALREADY-BOOKED note in your instructions). ' +
          'If they explicitly want to change it, tell them a coordinator will help reschedule — do not book here.',
      }
    }
  }

  // Get booking settings
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('*')
    .eq('organization_id', organizationId)
    .single()

  if (!settings || !settings.is_enabled) {
    return { success: false, data: {}, message: 'Online booking is not currently available. Please have the patient call to schedule.' }
  }

  // Get existing appointments
  const now = new Date()
  const futureDate = new Date(now.getTime() + settings.advance_days * 24 * 60 * 60 * 1000)

  const { data: existingAppts } = await supabase
    .from('appointments')
    .select('scheduled_at, duration_minutes, status')
    .eq('organization_id', organizationId)
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', futureDate.toISOString())
    .not('status', 'eq', 'canceled')

  const config: BookingConfig = {
    weekly_schedule: settings.weekly_schedule,
    slot_duration_minutes: settings.slot_duration_minutes,
    buffer_minutes: settings.buffer_minutes,
    advance_days: settings.advance_days,
    min_notice_hours: settings.min_notice_hours,
    blocked_dates: settings.blocked_dates || [],
    timezone: settings.timezone,
    max_bookings_per_slot: settings.max_bookings_per_slot || 1,
  }

  // Merge real CareStack occupancy so we never offer a chair that's already taken.
  const ehrBusy = await fetchEhrBusyAsAppointments(supabase, organizationId, settings.advance_days)
  const slots = generateAvailableSlots(config, [...((existingAppts || []) as ExistingAppointment[]), ...ehrBusy])

  // Filter by preferred day if specified
  let filteredSlots = slots
  if (preferredDay) {
    const dayMap: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
      thursday: 4, friday: 5, saturday: 6,
    }
    const dayNum = dayMap[preferredDay.toLowerCase()]
    if (dayNum !== undefined) {
      filteredSlots = slots.filter(s => s.dayOfWeek === dayNum)
    }
  }

  if (filteredSlots.length === 0) {
    return {
      success: true,
      data: { slots: [], duration: settings.slot_duration_minutes },
      message: preferredDay
        ? `No available slots on ${preferredDay}s in the next ${settings.advance_days} days. Other available dates: ${slots.slice(0, 3).map(s => s.dayLabel).join(', ')}.`
        : 'No available appointment slots in the upcoming schedule.',
    }
  }

  // Flatten into individual date+time options, soonest first, so the agent
  // offers COMBINED slots ("Tuesday, July 14 at 9:00 AM") rather than a menu of
  // days and a separate menu of times — the split-menu style confuses patients.
  const flatOptions = filteredSlots.flatMap(day =>
    day.times.map(t => `${day.dayLabel} at ${formatTimeDisplay(t)}`)
  )
  const offerList = flatOptions.slice(0, 6).map(o => `- ${o}`).join('\n')
  const first = flatOptions[0]
  const second = flatOptions[1]

  return {
    success: true,
    data: {
      slots: filteredSlots.slice(0, 5).map(d => ({
        date: d.date,
        dayLabel: d.dayLabel,
        times: d.times.slice(0, 6),
      })),
      duration: settings.slot_duration_minutes,
      location: settings.location || null,
    },
    message: [
      `Available ${settings.slot_duration_minutes}-minute consultation slots, soonest first:`,
      offerList,
      '',
      'HOW TO OFFER — IMPORTANT:',
      `- Offer only the FIRST 2 options as complete date+time slots${
        first && second ? ` (e.g. "I've got ${first} or ${second} — which works better?")` : ''
      }.`,
      '- Never dump the whole list, and never split days and times into two separate menus. Every option the patient picks must be ONE specific date AND time together.',
      '- If neither of the first two works, then offer the next 2 from the list — keep narrowing 2 at a time.',
    ].join('\n'),
  }
}

/**
 * Sanity-check a patient-stated DOB before persisting it. Returns an error
 * message for the agent to act on, or null when the value is usable. Guards
 * against transcription artifacts (voice) and format drift, not clinical truth.
 */
export function validatePatientDob(dob: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    return 'The date of birth must be in YYYY-MM-DD format. Confirm the patient\'s birth date (month, day, and year) and try again.'
  }
  const parsed = new Date(`${dob}T00:00:00Z`)
  const [y, m, d] = dob.split('-').map(Number)
  const isRealDate =
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() + 1 === m && parsed.getUTCDate() === d
  const age = (Date.now() - parsed.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
  if (!isRealDate || age < 0 || age > 120) {
    return `"${dob}" does not look like a valid date of birth — it may have been heard or transcribed wrong. Read it back to the patient to confirm, then try again.`
  }
  return null
}

async function executeCreateBooking(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  date: string,
  time: string,
  dateOfBirth?: string
): Promise<ToolResult> {
  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return { success: false, data: {}, message: 'Invalid date or time format. Use YYYY-MM-DD for date and HH:MM for time.' }
  }

  // Already-booked guard: never silently create a SECOND consultation. If the
  // patient wants a different time that's a reschedule (coordinator-handled),
  // not a fresh booking — otherwise a stray "yes" double-books them.
  {
    const { getActiveUpcomingAppointment } = await import('@/lib/appointments/upcoming')
    const existing = await getActiveUpcomingAppointment(supabase, context.organization_id, context.lead_id).catch(() => null)
    if (existing) {
      return {
        success: false,
        data: { already_booked: true, scheduled_at: existing.scheduled_at },
        message:
          'This patient already has a confirmed consultation. Do NOT create another booking. ' +
          'Confirm their existing time back to them. If they want a different time, tell them a coordinator will help them reschedule.',
      }
    }
  }

  // Get booking settings
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('*')
    .eq('organization_id', context.organization_id)
    .single()

  if (!settings) {
    return { success: false, data: {}, message: 'Booking is not available. Please have the patient call to schedule.' }
  }

  // Phone-first gate: on text channels (SMS/email) the AI may NOT book a
  // consultation until a real phone conversation has happened. On a live voice
  // call the conversation IS happening now, so booking is allowed. This hard
  // stop makes the agent pivot to scheduling a call instead (see message).
  if (isCallGateEnabled(settings) && context.channel !== 'voice') {
    const talked = await hasQualifyingCall(supabase, context.organization_id, context.lead_id)
    if (!talked) {
      return {
        success: false,
        data: { requires_phone_call: true },
        message:
          'This practice books consultations by phone, not by text. Do NOT create a booking now. ' +
          'Instead, warmly offer to set up a quick phone call with a coordinator to go over their situation ' +
          'and answer questions, and ask for the best time to reach them.',
      }
    }
  }

  // DOB gate: CareStack needs a real date of birth to register the patient —
  // without one the EHR sync falls back to a 1900-01-01 stub that staff must
  // chase down later. Collect it at booking time, where the patient is already
  // confirming details. "declined" is the explicit escape hatch so a privacy-
  // conscious patient never loses their slot over it.
  if (dateOfBirth && dateOfBirth !== 'declined') {
    const dobError = validatePatientDob(dateOfBirth)
    if (dobError) return { success: false, data: {}, message: dobError }
    // Plain write: leads.date_of_birth is a `date` column (never encrypted).
    const { error: dobWriteError } = await supabase
      .from('leads')
      .update({ date_of_birth: dateOfBirth })
      .eq('id', context.lead_id)
      .eq('organization_id', context.organization_id)
    if (dobWriteError) {
      logger.error('create_booking failed to save date_of_birth', { lead_id: context.lead_id }, new Error(dobWriteError.message))
    }
  } else if (!dateOfBirth) {
    // Read fresh — context.lead can be stale mid-conversation.
    const { data: dobRow } = await supabase
      .from('leads')
      .select('date_of_birth')
      .eq('id', context.lead_id)
      .single()
    if (!dobRow?.date_of_birth) {
      return {
        success: false,
        data: { requires_date_of_birth: true },
        message:
          'Before booking, ask the patient for their date of birth — the practice needs it to set up their appointment in the records system. ' +
          'Then call create_booking again with the same date and time plus date_of_birth (YYYY-MM-DD). ' +
          'If the patient prefers not to share it, reassure them that\'s fine and call create_booking again with date_of_birth set to "declined" — staff will collect it at the visit.',
      }
    }
  }

  // Store the absolute UTC instant for the practice-local (date, time). The
  // column is timestamptz, so a naive string would be misread as UTC.
  const scheduledAt = zonedTimeToUtc(date, time, settings.timezone).toISOString()

  // Verify slot is still available
  const now = new Date()
  const futureDate = new Date(now.getTime() + settings.advance_days * 24 * 60 * 60 * 1000)

  const { data: existingAppts } = await supabase
    .from('appointments')
    .select('scheduled_at, duration_minutes, status')
    .eq('organization_id', context.organization_id)
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', futureDate.toISOString())
    .not('status', 'eq', 'canceled')

  const config: BookingConfig = {
    weekly_schedule: settings.weekly_schedule,
    slot_duration_minutes: settings.slot_duration_minutes,
    buffer_minutes: settings.buffer_minutes,
    advance_days: settings.advance_days,
    min_notice_hours: settings.min_notice_hours,
    blocked_dates: settings.blocked_dates || [],
    timezone: settings.timezone,
    max_bookings_per_slot: settings.max_bookings_per_slot || 1,
  }

  const ehrBusy = await fetchEhrBusyAsAppointments(supabase, context.organization_id, settings.advance_days)
  const availableSlots = generateAvailableSlots(config, [...((existingAppts || []) as ExistingAppointment[]), ...ehrBusy])
  const daySlots = availableSlots.find(d => d.date === date)

  if (!daySlots || !daySlots.times.includes(time)) {
    return {
      success: false,
      data: {},
      message: `The ${formatTimeDisplay(time)} slot on ${date} is no longer available. Please check availability again and offer the patient another time.`,
    }
  }

  // Create the appointment
  const { data: appointment, error } = await supabase
    .from('appointments')
    .insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      type: 'consultation',
      scheduled_at: scheduledAt,
      duration_minutes: settings.slot_duration_minutes,
      location: settings.location || null,
      status: 'scheduled',
      booked_via: 'ai',
      no_show_fee_cents: settings.no_show_fee_enabled ? settings.no_show_fee_cents : null,
      notes: 'Booked via AI agent during conversation',
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') {
      return { success: false, data: {}, message: 'This slot was just booked by someone else. Please offer the patient another time.' }
    }
    return { success: false, data: {}, message: 'Failed to create the booking. Please try again or have the patient call to schedule.' }
  }

  // Fire-and-forget: push to CareStack + Dion Clinical + Slack. Never blocks the AI turn.
  void syncAppointmentToEhr(supabase, appointment!.id, { action: 'book' })

  // Update lead status
  await supabase
    .from('leads')
    .update(encryptLeadPII({
      status: 'consultation_scheduled',
      consultation_date: scheduledAt,
    }))
    .eq('id', context.lead_id)

  // Advance the pipeline BOARD stage too (status above only moves the text
  // field; the board groups by stage_id). Monotonic + fail-soft.
  const { advanceStageOnBooking } = await import('@/lib/pipeline/booking-stage')
  await advanceStageOnBooking(supabase, {
    organizationId: context.organization_id,
    leadId: context.lead_id,
    source: 'booking:ai',
  })

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: context.organization_id,
    lead_id: context.lead_id,
    activity_type: 'appointment_scheduled',
    title: `AI booked consultation for ${new Date(scheduledAt).toLocaleDateString()}`,
    metadata: {
      appointment_id: appointment!.id,
      source: 'ai_agent',
      conversation_id: context.conversation_id,
    },
  })

  // HIPAA audit for PHI-touching booking action
  auditPHIWrite(
    { supabase, organizationId: context.organization_id, actorType: 'ai_agent' },
    'appointment',
    appointment!.id,
    'AI agent created appointment booking during conversation',
  )

  // Send confirmation SMS + email. Both are transactional confirmations of an
  // appointment the patient just agreed to: SMS consent is enforced inside
  // sendSMSToLead; email is sent unless the patient has opted out.
  const phone = context.lead.phone_formatted
    ? (decryptField(context.lead.phone_formatted as string) || context.lead.phone_formatted)
    : null
  const email = context.lead.email
    ? (decryptField(context.lead.email as string) || context.lead.email as string)
    : null

  if ((phone && typeof phone === 'string') || (email && typeof email === 'string')) {
    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', context.organization_id)
      .single()

    const orgName = org?.name || 'our practice'
    const displayDate = new Date(scheduledAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: settings.timezone })
    const displayTime = formatTimeDisplay(time)

    if (phone && typeof phone === 'string') {
      // AWAIT the send — do not fire-and-forget. When this runs inside a voice
      // custom-function endpoint (book_appointment), the serverless function is
      // frozen the instant we return, so a dangling send promise never reaches
      // Twilio and the patient gets no confirmation. Consent denial is handled
      // inside sendSMSToLead and surfaced as a rejection we swallow here — the
      // booking already succeeded, so a failed confirmation must not fail it.
      try {
        await sendSMSToLead({
          supabase,
          leadId: context.lead_id,
          to: phone,
          body: `✅ Confirmed! Your consultation at ${orgName} is booked for ${displayDate} at ${displayTime}. We look forward to seeing you!`,
          caller: 'autopilot.book_appointment',
        })
      } catch { /* Non-critical; consent denial is handled inside the gate */ }

      // No-show fee: text a card-on-file link (charged only on a no-show).
      if (settings.no_show_fee_enabled) {
        await sendCardCaptureLink(supabase, context.organization_id, {
          appointmentId: appointment!.id,
          leadId: context.lead_id,
          feeCents: settings.no_show_fee_cents ?? 5000,
          phone,
          orgName,
        })
      }
    }

    if (email && typeof email === 'string' && !context.lead.email_opt_out) {
      const firstName = (context.lead.first_name as string) || 'there'
      // AWAIT for the same serverless-freeze reason as the SMS above.
      try {
        await sendEmail({
        to: email,
        subject: `Consultation Confirmed — ${escapeHtml(orgName)}`,
        html: `
          <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #111;">Your Consultation is Confirmed!</h2>
            <p>Hi ${escapeHtml(firstName)},</p>
            <p>You're all set for your consultation at <strong>${escapeHtml(orgName)}</strong>.</p>
            <div style="background: #f9f9f9; padding: 16px; border-radius: 8px; margin: 20px 0;">
              <p style="margin: 4px 0;"><strong>Date:</strong> ${escapeHtml(displayDate)}</p>
              <p style="margin: 4px 0;"><strong>Time:</strong> ${escapeHtml(displayTime)}</p>
              <p style="margin: 4px 0;"><strong>Duration:</strong> ${settings.slot_duration_minutes} minutes</p>
              ${settings.location ? `<p style="margin: 4px 0;"><strong>Location:</strong> ${escapeHtml(settings.location)}</p>` : ''}
            </div>
            <p>${escapeHtml(settings.booking_message || 'We look forward to seeing you!')}</p>
            ${settings.youtube_testimonial_url ? `<p style="margin: 20px 0;">Before your visit, hear from patients who've been through the same procedure: <a href="${escapeHtml(settings.youtube_testimonial_url as string)}" style="color: #0a7d3c; font-weight: 600;">watch their stories →</a></p>` : ''}
            <p style="color: #666; font-size: 12px; margin-top: 24px;">
              Need to reschedule? Reply to this email or call us.
            </p>
          </div>
        `,
        text: `Hi ${firstName}, your consultation at ${orgName} is confirmed for ${displayDate} at ${displayTime}. ${settings.location ? `Location: ${settings.location}. ` : ''}We look forward to seeing you!${settings.youtube_testimonial_url ? `\n\nBefore your visit, hear from patients who've been through the same procedure: ${settings.youtube_testimonial_url}` : ''}`,
        })
      } catch (err) {
        await supabase.from('lead_activities').insert({
          organization_id: context.organization_id,
          lead_id: context.lead_id,
          activity_type: 'notification_failed',
          title: 'Booking confirmation email failed',
          metadata: { error: err instanceof Error ? err.message : 'unknown', channel: 'email', appointment_id: appointment!.id },
        })
      }
    }
  }

  const displayDate = new Date(scheduledAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: settings.timezone })

  return {
    success: true,
    data: {
      appointment_id: appointment!.id,
      scheduled_at: scheduledAt,
      duration: settings.slot_duration_minutes,
      location: settings.location,
    },
    message: `Appointment successfully booked for ${displayDate} at ${formatTimeDisplay(time)}. Duration: ${settings.slot_duration_minutes} minutes.${settings.location ? ` Location: ${settings.location}.` : ''} A confirmation message has been sent to the patient.`,
  }
}

async function executeCheckFinancingStatus(
  supabase: SupabaseClient,
  leadId: string
): Promise<ToolResult> {
  const { data: applications } = await supabase
    .from('financing_applications')
    .select('id, status, lender_name, approved_amount, monthly_payment, interest_rate, term_months')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(5)

  if (!applications || applications.length === 0) {
    return {
      success: true,
      data: { has_applications: false },
      message: 'No financing applications on file. You can offer to send the patient a financing application link.',
    }
  }

  const approved = applications.filter(a => a.status === 'approved')
  const pending = applications.filter(a => a.status === 'pending')

  let message = ''
  if (approved.length > 0) {
    const best = approved.sort((a, b) => (b.approved_amount || 0) - (a.approved_amount || 0))[0]
    message = `Patient has ${approved.length} approved financing option(s). Best offer: $${best.approved_amount?.toLocaleString()} from ${best.lender_name} at ${best.monthly_payment ? `$${best.monthly_payment}/mo` : 'TBD monthly payment'}.`
  } else if (pending.length > 0) {
    message = `Patient has ${pending.length} pending application(s). Waiting for lender decisions.`
  } else {
    message = `Patient has ${applications.length} application(s) but none are approved. Consider reapplying or offering alternative financing.`
  }

  return {
    success: true,
    data: {
      has_applications: true,
      approved_count: approved.length,
      pending_count: pending.length,
      best_offer: approved[0] || null,
    },
    message,
  }
}

async function executeSendFinancingLink(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
  },
  treatmentValue?: number
): Promise<ToolResult> {
  // Qualification gate: the Closer only reaches this tool because the lead sits
  // in a closer-stage (STAGE_AGENT_MAP), but stage is set by external GHL sync
  // and is not a reliable proxy for "we've actually qualified this patient."
  // A mis-staged lead who never did discovery must NOT be pushed a financing
  // application (the "I haven't filled any application" failure). Require a real
  // qualification signal — goal + timeline + a financial signal — before we send.
  const qualification = buildQualificationStatus(context.lead as Partial<Lead>)
  if (!isDiscoveryComplete(qualification)) {
    return {
      success: false,
      data: {},
      message: 'This patient has not been qualified yet (we still need their goal, timeline, and a financing/credit signal), so do NOT send a financing link or tell them one was sent. Keep the conversation on understanding their situation, or have a team member follow up. Financing comes after qualification.',
    }
  }

  const phone = context.lead.phone_formatted
    ? (decryptField(context.lead.phone_formatted as string) || context.lead.phone_formatted)
    : null

  // Mint (or reuse) the patient's real share-token portal link. NEVER hand-roll
  // the URL: the public route is `/finance/{shareToken}` (share-token gated in
  // src/lib/auth/public-paths.ts), NOT `/financing/{leadId}`. A hand-built
  // `/financing/...` URL matches no route AND isn't a public prefix, so the auth
  // middleware bounces the patient to /login — the "link just takes me to the
  // sign in page" failure. getOrCreateFinancingShareLink also resolves the
  // stable public host (no ephemeral preview snapshot). See financing/share-link.ts.
  const link = await getOrCreateFinancingShareLink(supabase, {
    organizationId: context.organization_id,
    leadId: context.lead_id,
    requestedAmount: treatmentValue ?? (context.lead.treatment_value as number | undefined) ?? null,
  }).catch(() => null)

  if (!link) {
    return {
      success: false,
      data: {},
      message: 'Could not generate the financing application link right now. Do NOT tell the patient a link was sent. Let them know a team member will follow up with their financing options, and flag it for a human.',
    }
  }

  const financingUrl = link.url

  if (phone && typeof phone === 'string') {
    const valueText = treatmentValue ? ` for your $${treatmentValue.toLocaleString()} treatment plan` : ''
    const sendRes = await sendSMSToLead({
      supabase,
      leadId: context.lead_id,
      to: phone,
      body: `Here's your personalized financing link${valueText}. See your payment options and apply in 2 minutes (soft credit check only): ${financingUrl}`,
      caller: 'autopilot.send_financing_link',
    })

    if (!sendRes.sent) {
      return {
        success: false,
        data: {},
        message: 'Could not send financing link via SMS — patient has opted out of SMS (DND). Share the financing information verbally in the conversation.',
      }
    }

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      activity_type: 'financing_link_sent',
      title: 'AI sent financing application link via SMS',
      metadata: { treatment_value: treatmentValue, source: 'ai_agent' },
    })

    // HIPAA audit for PHI-touching financing action
    auditPHIWrite(
      { supabase, organizationId: context.organization_id, actorType: 'ai_agent' },
      'financing',
      context.lead_id,
      'AI agent sent financing application link via SMS',
    )

    return {
      success: true,
      data: { financing_url: financingUrl },
      message: 'Financing application link has been sent to the patient via SMS. The application uses a soft credit check that won\'t affect their score.',
    }
  }

  return {
    success: false,
    data: {},
    message: 'Could not send financing link — no phone number on file. Share the financing information verbally in the conversation.',
  }
}

// ═══════════════════════════════════════════════════════════
// CROSS-CHANNEL TOOL IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════

/**
 * Helper: Get lead contact info and org name for cross-channel delivery.
 */
async function getCrossChannelContext(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
  }
): Promise<{ phone: string | null; email: string | null; leadName: string; orgName: string }> {
  const phone = context.lead.phone_formatted
    ? (decryptField(context.lead.phone_formatted as string) || context.lead.phone_formatted as string)
    : null

  const email = context.lead.email
    ? (decryptField(context.lead.email as string) || context.lead.email as string)
    : null

  const leadName = (context.lead.first_name as string) || ''

  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', context.organization_id)
    .single()

  return { phone, email, leadName, orgName: org?.name || 'our practice' }
}

/**
 * Helper: Store an outbound message record from a cross-channel delivery.
 */
async function storeOutboundMessage(
  supabase: SupabaseClient,
  params: {
    organization_id: string
    conversation_id: string
    lead_id: string
    channel: 'sms' | 'email'
    body: string
    external_id?: string
    metadata?: Record<string, unknown>
    agent_role?: 'setter' | 'closer'
  }
): Promise<string | null> {
  // Attribute to the specific agent. If the caller didn't supply a role,
  // fall back to the conversation's active_agent — same convention used
  // by the historical backfill in migration 030.
  let role: 'setter' | 'closer' | undefined = params.agent_role
  if (!role) {
    const { data: conv } = await supabase
      .from('conversations')
      .select('active_agent')
      .eq('id', params.conversation_id)
      .maybeSingle()
    if (conv?.active_agent === 'setter' || conv?.active_agent === 'closer') {
      role = conv.active_agent
    }
  }
  const agentId = role
    ? await getAgentIdForRole(supabase, params.organization_id, role)
    : null

  const { data } = await supabase
    .from('messages')
    .insert({
      organization_id: params.organization_id,
      conversation_id: params.conversation_id,
      lead_id: params.lead_id,
      agent_id: agentId,
      direction: 'outbound',
      channel: params.channel,
      body: params.body,
      sender_type: 'ai',
      status: 'sent',
      external_id: params.external_id || null,
      ai_generated: true,
      metadata: {
        cross_channel: true,
        ...params.metadata,
      },
    })
    .select('id')
    .single()

  return data?.id || null
}

/**
 * send_sms_to_lead — Send a custom SMS to the lead.
 */
async function executeSendSMSToLead(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  message: string
): Promise<ToolResult> {
  // Same-channel guard: this is a CROSS-channel tool (voice/email → SMS). In an
  // SMS conversation the reply already IS a text, so a tool send here produces
  // two back-to-back texts — the second oddly narrating the first ("Sent! Check
  // your messages."). Soft-refuse so the model folds the content into its reply.
  if (context.channel === 'sms') {
    return {
      success: false,
      data: { same_channel: true },
      message: 'Not sent — you are already texting with this patient, so do NOT use this tool. Put the content (including any links) directly in your reply; your reply IS the text message they receive. This tool is only for sending a text from a DIFFERENT channel (e.g., while on a phone call).',
    }
  }

  // Consent check
  if (context.lead.sms_opt_out) {
    return { success: false, data: {}, message: 'Cannot send SMS — patient has opted out of SMS (DND). Provide the information verbally instead.' }
  }

  const { phone, leadName, orgName } = await getCrossChannelContext(supabase, context)
  if (!phone) {
    return { success: false, data: {}, message: 'Cannot send SMS — no phone number on file. Ask the patient for their phone number.' }
  }

  const formattedMessage = formatCustomSMS(message, leadName)

  try {
    const sendRes = await sendSMSToLead({
      supabase, leadId: context.lead_id, to: phone, body: formattedMessage, caller: 'autopilot.send_sms_to_lead',
    })
    if (!sendRes.sent) {
      return { success: false, data: {}, message: 'Cannot send SMS — patient has opted out of SMS (DND). Provide the information verbally instead.' }
    }
    const result = { sid: sendRes.sid }

    // Store message record
    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'sms',
      body: formattedMessage,
      external_id: result.sid,
      metadata: { tool: 'send_sms_to_lead', source_channel: context.channel },
    })

    // Track cross-channel delivery
    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'sms',
      content_type: 'custom_message',
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_sms_to_lead',
    })

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      activity_type: 'cross_channel_sms_sent',
      title: `AI sent SMS during ${context.channel || 'conversation'}`,
      description: formattedMessage.substring(0, 200),
      metadata: { tool: 'send_sms_to_lead', source_channel: context.channel },
    })

    // HIPAA audit
    auditPHITransmission(
      { supabase, organizationId: context.organization_id, actorType: 'ai_agent' },
      'cross_channel_sms',
      context.lead_id,
      'Twilio (SMS)',
      ['phone']
    )

    return {
      success: true,
      data: { message_id: messageId },
      message: `SMS sent successfully to the patient. Message: "${formattedMessage.substring(0, 100)}..."`,
    }
  } catch (error) {
    return {
      success: false,
      data: {},
      message: `Failed to send SMS: ${error instanceof Error ? error.message : 'Unknown error'}. Share the information verbally instead.`,
    }
  }
}

/**
 * send_email_to_lead — Send a custom email to the lead.
 */
async function executeSendEmailToLead(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  subject: string,
  message: string
): Promise<ToolResult> {
  // Consent check
  if (context.lead.email_opt_out) {
    return { success: false, data: {}, message: 'Cannot send email — patient has opted out of email (DND). Provide the information verbally or via SMS instead.' }
  }

  const { email, leadName, orgName } = await getCrossChannelContext(supabase, context)
  if (!email) {
    return { success: false, data: {}, message: 'Cannot send email — no email address on file. Ask the patient for their email address.' }
  }

  // Wrapper branding must match the body branding: resolve the lead's
  // service-line DBA (implant leads → Dion Health; TMJ brand only for
  // explicitly-signalled TMJ/sleep leads) instead of the raw org name.
  const brand = await resolveBrandIdentity(supabase, context.organization_id, {
    lead: context.lead as Partial<Lead>,
    fallbackServiceLine: 'implants',
  }).catch(() => null)

  const formatted = formatCustomEmail(message, leadName, orgName, {
    subject,
    leadId: context.lead_id,
    orgId: context.organization_id,
    brandName: brand?.practiceName,
  })

  try {
    const result = await sendEmail({
      to: email,
      subject: formatted.subject,
      html: formatted.html,
      text: formatted.text,
    })

    // Store message record
    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'email',
      body: message,
      external_id: result.id,
      metadata: { tool: 'send_email_to_lead', subject, source_channel: context.channel },
    })

    // Track cross-channel delivery
    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'email',
      content_type: 'custom_message',
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_email_to_lead',
    })

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      activity_type: 'cross_channel_email_sent',
      title: `AI sent email during ${context.channel || 'conversation'}: ${subject}`,
      metadata: { tool: 'send_email_to_lead', subject, source_channel: context.channel },
    })

    return {
      success: true,
      data: { message_id: messageId },
      message: `Email sent successfully to the patient with subject "${subject}".`,
    }
  } catch (error) {
    return {
      success: false,
      data: {},
      message: `Failed to send email: ${error instanceof Error ? error.message : 'Unknown error'}. Share the information verbally or via SMS instead.`,
    }
  }
}

/**
 * send_practice_info — Send practice address, hours, and directions.
 */
async function executeSendPracticeInfo(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  deliveryChannel: string
): Promise<ToolResult> {
  const { phone, email, leadName, orgName } = await getCrossChannelContext(supabase, context)

  // Get practice info asset
  const practiceInfo = await getPracticeInfo(supabase, context.organization_id)
  if (!practiceInfo) {
    // Fallback: try to get from org settings
    const { data: org } = await supabase
      .from('organizations')
      .select('address, phone, website')
      .eq('id', context.organization_id)
      .single()

    if (org?.address) {
      const addr = org.address as Record<string, string>
      const addressText = [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(', ')
      return {
        success: true,
        data: { address: addressText },
        message: `Practice address: ${addressText}${org.phone ? `. Phone: ${org.phone}` : ''}. Note: No detailed practice info asset configured. The address has been shared verbally.`,
      }
    }
    return { success: false, data: {}, message: 'No practice info configured. Share the address verbally.' }
  }

  // Track usage
  await incrementUsage(supabase, practiceInfo.id)

  if (deliveryChannel === 'sms') {
    if (context.lead.sms_opt_out || !phone) {
      return { success: false, data: {}, message: 'Cannot send SMS — no consent or no phone. Share practice info verbally.' }
    }

    const smsContent = formatAssetForSMS(practiceInfo, leadName, orgName)
    const sendRes = await sendSMSToLead({
      supabase, leadId: context.lead_id, to: phone, body: smsContent, caller: 'autopilot.send_asset',
    })
    if (!sendRes.sent) {
      return { success: false, data: {}, message: 'Cannot send SMS — patient has opted out of SMS (DND). Share verbally instead.' }
    }
    const result = { sid: sendRes.sid }

    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'sms',
      body: smsContent,
      external_id: result.sid,
      metadata: { tool: 'send_practice_info', content_asset_id: practiceInfo.id },
    })

    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'sms',
      content_type: 'practice_info',
      content_asset_id: practiceInfo.id,
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_practice_info',
    })

    await supabase.from('lead_activities').insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      activity_type: 'cross_channel_practice_info_sent',
      title: `AI sent practice info via SMS during ${context.channel || 'conversation'}`,
      metadata: { tool: 'send_practice_info', delivery_channel: 'sms' },
    })

    return { success: true, data: { content_asset_id: practiceInfo.id }, message: 'Practice address and directions have been texted to the patient.' }
  } else {
    // Email delivery
    if (context.lead.email_opt_out || !email) {
      return { success: false, data: {}, message: 'Cannot send email — no consent or no email address. Try SMS or share verbally.' }
    }

    const emailContent = formatAssetForEmail(practiceInfo, leadName, orgName, {
      leadId: context.lead_id,
      orgId: context.organization_id,
    })

    const result = await sendEmail({ to: email, ...emailContent })

    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'email',
      body: emailContent.text,
      external_id: result.id,
      metadata: { tool: 'send_practice_info', content_asset_id: practiceInfo.id, subject: emailContent.subject },
    })

    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'email',
      content_type: 'practice_info',
      content_asset_id: practiceInfo.id,
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_practice_info',
    })

    return { success: true, data: { content_asset_id: practiceInfo.id }, message: 'Practice address and directions have been emailed to the patient.' }
  }
}

/**
 * send_testimonial — Send a patient testimonial video/story.
 */
async function executeSendTestimonial(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  deliveryChannel: string
): Promise<ToolResult> {
  const { phone, email, leadName, orgName } = await getCrossChannelContext(supabase, context)

  // Get a random testimonial (for variety)
  const testimonials = await getRandomAssets(supabase, context.organization_id, 'testimonial_video', 1)
  if (testimonials.length === 0) {
    // Fallback: a practice may configure a single doctor testimonial URL in
    // Settings → Booking protocol instead of uploading testimonial assets.
    const { data: bs } = await supabase
      .from('booking_settings')
      .select('youtube_testimonial_url')
      .eq('organization_id', context.organization_id)
      .maybeSingle()
    const url = (bs?.youtube_testimonial_url as string | null) || null

    if (url) {
      if (deliveryChannel === 'sms') {
        if (context.lead.sms_opt_out || !phone) {
          return { success: false, data: {}, message: 'Cannot send SMS — no consent or no phone. Mention the testimonials verbally.' }
        }
        const body = `${leadName ? leadName + ', ' : ''}here are real ${orgName} patients sharing their full-arch journey: ${url}`
        const sendRes = await sendSMSToLead({ supabase, leadId: context.lead_id, to: phone, body, caller: 'autopilot.send_asset' })
        if (!sendRes.sent) {
          return { success: false, data: {}, message: 'Cannot send SMS — patient has opted out of SMS (DND). Share verbally instead.' }
        }
        await supabase.from('lead_activities').insert({
          organization_id: context.organization_id,
          lead_id: context.lead_id,
          activity_type: 'cross_channel_testimonial_sent',
          title: 'AI sent doctor testimonial video via SMS',
          metadata: { tool: 'send_testimonial', url, delivery_channel: 'sms', source: 'configured_url' },
        })
        return { success: true, data: { url }, message: 'Sent the practice testimonial video link to the patient via SMS.' }
      }

      if (context.lead.email_opt_out || !email) {
        return { success: false, data: {}, message: 'Cannot send email — no consent or no email. Mention the testimonials verbally.' }
      }
      await sendEmail({
        to: email,
        subject: `Patient stories from ${orgName}`,
        html: `<p>Hi ${leadName || 'there'},</p><p>Here are real patients sharing their full-arch experience:</p><p><a href="${url}">Watch patient testimonials</a></p>`,
        text: `Hi ${leadName || 'there'}, here are real patients sharing their experience: ${url}`,
      })
      await supabase.from('lead_activities').insert({
        organization_id: context.organization_id,
        lead_id: context.lead_id,
        activity_type: 'cross_channel_testimonial_sent',
        title: 'AI sent doctor testimonial video via email',
        metadata: { tool: 'send_testimonial', url, delivery_channel: 'email', source: 'configured_url' },
      })
      return { success: true, data: { url }, message: 'Emailed the practice testimonial video link to the patient.' }
    }

    return { success: false, data: {}, message: 'No testimonial videos configured. Mention verbally that you have many happy patients and offer to share more during the consultation.' }
  }

  const testimonial = testimonials[0]
  await incrementUsage(supabase, testimonial.id)

  if (deliveryChannel === 'sms') {
    if (context.lead.sms_opt_out || !phone) {
      return { success: false, data: {}, message: 'Cannot send SMS — no consent or no phone. Mention the testimonials verbally.' }
    }

    const smsContent = formatAssetForSMS(testimonial, leadName, orgName)
    const sendRes = await sendSMSToLead({
      supabase, leadId: context.lead_id, to: phone, body: smsContent, caller: 'autopilot.send_asset',
    })
    if (!sendRes.sent) {
      return { success: false, data: {}, message: 'Cannot send SMS — patient has opted out of SMS (DND). Share verbally instead.' }
    }
    const result = { sid: sendRes.sid }

    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'sms',
      body: smsContent,
      external_id: result.sid,
      metadata: { tool: 'send_testimonial', content_asset_id: testimonial.id },
    })

    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'sms',
      content_type: 'testimonial_video',
      content_asset_id: testimonial.id,
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_testimonial',
    })

    await supabase.from('lead_activities').insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      activity_type: 'cross_channel_testimonial_sent',
      title: `AI sent testimonial video via SMS: ${testimonial.title}`,
      metadata: { tool: 'send_testimonial', asset_title: testimonial.title, delivery_channel: 'sms' },
    })

    return { success: true, data: { content_asset_id: testimonial.id, title: testimonial.title }, message: `Patient testimonial "${testimonial.title}" has been texted to the patient with a link to the video.` }
  } else {
    if (context.lead.email_opt_out || !email) {
      return { success: false, data: {}, message: 'Cannot send email — no consent or no email. Try SMS or mention verbally.' }
    }

    const emailContent = formatAssetForEmail(testimonial, leadName, orgName, {
      leadId: context.lead_id,
      orgId: context.organization_id,
    })

    const result = await sendEmail({ to: email, ...emailContent })

    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'email',
      body: emailContent.text,
      external_id: result.id,
      metadata: { tool: 'send_testimonial', content_asset_id: testimonial.id, subject: emailContent.subject },
    })

    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'email',
      content_type: 'testimonial_video',
      content_asset_id: testimonial.id,
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_testimonial',
    })

    return { success: true, data: { content_asset_id: testimonial.id, title: testimonial.title }, message: `Patient testimonial "${testimonial.title}" has been emailed to the patient with an embedded video link.` }
  }
}

/**
 * send_before_after — Send before/after transformation photos.
 */
async function executeSendBeforeAfter(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  deliveryChannel: string
): Promise<ToolResult> {
  const { phone, email, leadName, orgName } = await getCrossChannelContext(supabase, context)

  // Get random before/after photos (send up to 2 for variety)
  const photos = await getRandomAssets(supabase, context.organization_id, 'before_after_photo', 2)
  if (photos.length === 0) {
    return { success: false, data: {}, message: 'No before/after photos configured. Mention verbally that you can show them transformations during the consultation.' }
  }

  const photo = photos[0]
  await incrementUsage(supabase, photo.id)

  if (deliveryChannel === 'sms') {
    if (context.lead.sms_opt_out || !phone) {
      return { success: false, data: {}, message: 'Cannot send SMS — no consent or no phone. Try email or mention verbally.' }
    }

    const smsContent = formatAssetForSMS(photo, leadName, orgName)
    const sendRes = await sendSMSToLead({
      supabase, leadId: context.lead_id, to: phone, body: smsContent, caller: 'autopilot.send_asset',
    })
    if (!sendRes.sent) {
      return { success: false, data: {}, message: 'Cannot send SMS — patient has opted out of SMS (DND). Share verbally instead.' }
    }
    const result = { sid: sendRes.sid }

    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'sms',
      body: smsContent,
      external_id: result.sid,
      metadata: { tool: 'send_before_after', content_asset_id: photo.id },
    })

    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'sms',
      content_type: 'before_after_photo',
      content_asset_id: photo.id,
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_before_after',
    })

    await supabase.from('lead_activities').insert({
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      activity_type: 'cross_channel_before_after_sent',
      title: `AI sent before/after photos via SMS: ${photo.title}`,
      metadata: { tool: 'send_before_after', asset_title: photo.title, delivery_channel: 'sms' },
    })

    return { success: true, data: { content_asset_id: photo.id }, message: `Before/after transformation "${photo.title}" has been texted to the patient with a link to view the photos.` }
  } else {
    if (context.lead.email_opt_out || !email) {
      return { success: false, data: {}, message: 'Cannot send email — no consent or no email. Try SMS instead.' }
    }

    const emailContent = formatAssetForEmail(photo, leadName, orgName, {
      leadId: context.lead_id,
      orgId: context.organization_id,
    })

    const result = await sendEmail({ to: email, ...emailContent })

    const messageId = await storeOutboundMessage(supabase, {
      organization_id: context.organization_id,
      conversation_id: context.conversation_id,
      lead_id: context.lead_id,
      channel: 'email',
      body: emailContent.text,
      external_id: result.id,
      metadata: { tool: 'send_before_after', content_asset_id: photo.id, subject: emailContent.subject },
    })

    await recordDelivery(supabase, {
      organization_id: context.organization_id,
      lead_id: context.lead_id,
      conversation_id: context.conversation_id,
      triggered_by_channel: context.channel || 'voice',
      delivered_via_channel: 'email',
      content_type: 'before_after_photo',
      content_asset_id: photo.id,
      message_id: messageId || undefined,
      status: 'sent',
      tool_name: 'send_before_after',
    })

    return { success: true, data: { content_asset_id: photo.id }, message: `Before/after transformation "${photo.title}" has been emailed to the patient with embedded comparison photos.` }
  }
}

// ═══════════════════════════════════════════════════════════
// TREATMENT CLOSING TOOLS
// ═══════════════════════════════════════════════════════════

async function executeCheckClosingProgress(
  supabase: SupabaseClient,
  leadId: string
): Promise<ToolResult> {
  const closing = await getTreatmentClosing(supabase, leadId)

  if (!closing) {
    return {
      success: true,
      data: { has_closing: false },
      message: 'No treatment closing workflow has been started for this patient yet. The workflow begins when the treatment plan is presented and the patient starts the commitment process.',
    }
  }

  const progress = getClosingProgress(closing)

  return {
    success: true,
    data: {
      has_closing: true,
      current_step: progress.current_step,
      percent_complete: progress.percent_complete,
      steps_completed: progress.steps_completed,
      steps_remaining: progress.steps_remaining,
      next_action: progress.next_action,
      surgery_date: closing.surgery_date,
      surgery_in_days: progress.surgery_in_days,
      blockers: progress.blockers,
    },
    message: `Treatment Closing Progress: ${progress.percent_complete}% complete.\nCurrent step: ${progress.current_step_label}\nNext action: ${progress.next_action}\n${progress.next_action_detail}\n${progress.blockers.length > 0 ? `⚠️ Blockers: ${progress.blockers.join('; ')}` : ''}${closing.surgery_date ? `\nSurgery scheduled: ${closing.surgery_date}` : ''}`,
  }
}

async function executeSendPreopInstructions(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
    channel?: string
  },
  channel: string
): Promise<ToolResult> {
  const phone = context.lead.phone as string | undefined
  const email = context.lead.email as string | undefined
  const firstName = (context.lead.first_name as string) || 'there'
  const decryptedPhone = phone ? decryptField(phone) : null
  const decryptedEmail = email ? decryptField(email) : null

  const preOpSMS = `${firstName}, here are your pre-op instructions for surgery day:\n\n🚫 Nothing to eat or drink 8 hours before\n🚗 Arrange a ride home (no driving after sedation)\n💊 Take prescribed meds as directed\n👕 Wear comfortable, loose clothing\n⏰ Arrive 15 min early\n🪪 Bring ID & insurance card\n🚭 No smoking 48 hours before\n\nPost-op care instructions will follow. Questions? Just text or call us!`

  const preOpEmail = `<h2>Pre-Operative Instructions</h2>
<p>Hi ${firstName},</p>
<p>Your surgery date is approaching — congratulations! Here's everything you need to know to prepare:</p>

<h3>Before Surgery</h3>
<ul>
<li><strong>Fasting:</strong> Nothing to eat or drink 8 hours before your appointment</li>
<li><strong>Transportation:</strong> Arrange a ride home — you cannot drive after IV sedation</li>
<li><strong>Medications:</strong> Take prescribed medications as directed by Dr. Samadian</li>
<li><strong>Clothing:</strong> Wear comfortable, loose-fitting clothing</li>
<li><strong>Arrival:</strong> Please arrive 15 minutes early</li>
<li><strong>Documents:</strong> Bring your photo ID and insurance card</li>
<li><strong>Smoking:</strong> No smoking for 48 hours before surgery</li>
</ul>

<h3>After Surgery (Post-Op Care)</h3>
<ul>
<li><strong>Ice:</strong> Apply ice packs 20 minutes on, 20 minutes off for the first 48 hours</li>
<li><strong>Diet:</strong> Soft foods only for the first 2 weeks (smoothies, soups, mashed potatoes, yogurt)</li>
<li><strong>Medications:</strong> Take ALL prescribed medications as directed — do not skip pain meds</li>
<li><strong>Oral Care:</strong> No spitting, no straws, no smoking for 72 hours</li>
<li><strong>Rinsing:</strong> Gentle warm salt water rinses after 24 hours</li>
<li><strong>Follow-up:</strong> Your follow-up appointment is in 7-10 days</li>
</ul>

<p><strong>Questions?</strong> Call or text us anytime. We're here for you!</p>
<p>— The Team at Dion Health</p>`

  const sentVia: string[] = []

  if ((channel === 'sms' || channel === 'both') && decryptedPhone) {
    try {
      const sendRes = await sendSMSToLead({
        supabase, leadId: context.lead_id, to: decryptedPhone, body: preOpSMS, caller: 'autopilot.send_preop_instructions',
      })
      if (!sendRes.sent) throw new Error(`sms_not_sent:${sendRes.reason}`)
      sentVia.push('SMS')

      await storeOutboundMessage(supabase, {
        organization_id: context.organization_id,
        conversation_id: context.conversation_id,
        lead_id: context.lead_id,
        channel: 'sms',
        body: preOpSMS,
        metadata: { tool: 'send_preop_instructions', type: 'preop' },
      })
    } catch (err) {
      console.error('[PreOp SMS] Error:', err)
    }
  }

  if ((channel === 'email' || channel === 'both') && decryptedEmail) {
    try {
      await sendEmail({
        to: decryptedEmail,
        subject: `${firstName}, Your Pre-Op & Post-Op Instructions — Please Read Before Surgery`,
        html: preOpEmail,
        text: preOpSMS,
      })
      sentVia.push('Email')

      await storeOutboundMessage(supabase, {
        organization_id: context.organization_id,
        conversation_id: context.conversation_id,
        lead_id: context.lead_id,
        channel: 'email',
        body: preOpSMS,
        metadata: { tool: 'send_preop_instructions', type: 'preop', subject: 'Pre-Op Instructions' },
      })
    } catch (err) {
      console.error('[PreOp Email] Error:', err)
    }
  }

  if (sentVia.length === 0) {
    return { success: false, data: {}, message: 'Could not send pre-op instructions — no valid phone or email on file.' }
  }

  // Advance treatment closing workflow
  await advanceStep(supabase, context.lead_id, 'preop_instructions_sent', {
    preop_sent_via: sentVia.length === 2 ? 'both' : sentVia[0].toLowerCase() as 'sms' | 'email',
  })

  await supabase.from('lead_activities').insert({
    organization_id: context.organization_id,
    lead_id: context.lead_id,
    activity_type: 'preop_instructions_sent',
    title: `Pre-op & post-op instructions sent via ${sentVia.join(' + ')}`,
    metadata: { tool: 'send_preop_instructions', channels: sentVia },
  })

  auditPHITransmission(
    { supabase, organizationId: context.organization_id, actorType: 'ai_agent' },
    'preop_instructions',
    context.lead_id,
    sentVia.join('+').toLowerCase(),
    ['phone', 'email']
  )

  return {
    success: true,
    data: { channels: sentVia },
    message: `Pre-operative and post-operative care instructions have been sent to the patient via ${sentVia.join(' and ')}. The instructions cover fasting, medication, transportation, and recovery care.`,
  }
}

async function executeScheduleFollowUp(
  supabase: SupabaseClient,
  context: {
    organization_id: string
    lead_id: string
    lead: Record<string, unknown>
    conversation_id: string
  },
  preferredDay?: string,
  consultationType: string = 'in_person'
): Promise<ToolResult> {
  // Get available slots (reuse existing availability logic)
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('*')
    .eq('organization_id', context.organization_id)
    .single()

  if (!settings || !settings.is_enabled) {
    return { success: false, data: {}, message: 'Online booking is not currently available. Please have the patient call to schedule a follow-up consultation.' }
  }

  const now = new Date()
  const futureDate = new Date(now.getTime() + settings.advance_days * 24 * 60 * 60 * 1000)

  const { data: existingAppts } = await supabase
    .from('appointments')
    .select('scheduled_at, duration_minutes, status')
    .eq('organization_id', context.organization_id)
    .gte('scheduled_at', now.toISOString())
    .lte('scheduled_at', futureDate.toISOString())
    .not('status', 'eq', 'canceled')

  const config: BookingConfig = {
    weekly_schedule: settings.weekly_schedule,
    slot_duration_minutes: settings.slot_duration_minutes,
    buffer_minutes: settings.buffer_minutes,
    advance_days: settings.advance_days,
    min_notice_hours: settings.min_notice_hours,
    blocked_dates: settings.blocked_dates || [],
    timezone: settings.timezone,
    max_bookings_per_slot: settings.max_bookings_per_slot || 1,
  }

  const ehrBusy = await fetchEhrBusyAsAppointments(supabase, context.organization_id, settings.advance_days)
  const slots = generateAvailableSlots(config, [...((existingAppts || []) as ExistingAppointment[]), ...ehrBusy])

  // Filter by preferred day if specified
  let filteredSlots = slots
  if (preferredDay) {
    const dayMap: Record<string, number> = {
      sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
      thursday: 4, friday: 5, saturday: 6,
    }
    const dayNum = dayMap[preferredDay.toLowerCase()]
    if (dayNum !== undefined) {
      filteredSlots = slots.filter(s => s.dayOfWeek === dayNum)
    }
  }

  if (filteredSlots.length === 0) {
    return {
      success: true,
      data: { slots: [] },
      message: preferredDay
        ? `No follow-up consultation slots available on ${preferredDay}s. Other available dates: ${slots.slice(0, 3).map(s => s.dayLabel).join(', ')}.`
        : 'No available follow-up consultation slots in the upcoming schedule. Please have the patient call the office directly.',
    }
  }

  // Flatten to combined date+time options (soonest first) so the agent offers
  // whole slots, not a day-menu plus a separate time-menu (confuses patients).
  const flatOptions = filteredSlots.flatMap(day =>
    day.times.map(t => `${day.dayLabel} at ${formatTimeDisplay(t)}`)
  )
  const offerList = flatOptions.slice(0, 6).map(o => `- ${o}`).join('\n')
  const first = flatOptions[0]
  const second = flatOptions[1]

  const typeLabel = consultationType === 'virtual' ? 'virtual video call' :
    consultationType === 'phone' ? 'phone consultation' : 'in-person follow-up'

  return {
    success: true,
    data: {
      slots: filteredSlots.slice(0, 5).map(d => ({
        date: d.date,
        dayLabel: d.dayLabel,
        times: d.times.slice(0, 6),
      })),
      consultation_type: consultationType,
    },
    message: [
      `Available ${typeLabel} slots, soonest first:`,
      offerList,
      '',
      'This is a follow-up consultation to address any remaining questions.',
      'HOW TO OFFER — IMPORTANT:',
      `- Offer only the FIRST 2 options as complete date+time slots${
        first && second ? ` (e.g. "I've got ${first} or ${second} — which works better?")` : ''
      }.`,
      '- Never dump the whole list, and never split days and times into two separate menus. Each option the patient picks must be ONE specific date AND time together.',
      '- If neither works, offer the next 2 — keep narrowing 2 at a time. Then use create_booking to confirm.',
    ].join('\n'),
  }
}
