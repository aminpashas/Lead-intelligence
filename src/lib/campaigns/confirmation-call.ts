/**
 * AI Confirmation Call — Retell Voice Integration
 *
 * Uses the existing voice call infrastructure to make AI-powered
 * appointment confirmation calls. The AI greets the patient,
 * confirms appointment details, and records their response.
 *
 * Integrates with:
 * - preCallCheck() for consent/DNC verification
 * - initiateOutboundCall() for call lifecycle management
 * - processCallEnd() for post-call processing
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { preCallCheck, initiateOutboundCall } from '@/lib/voice/call-manager'
import { logger } from '@/lib/logger'

// ═══════════════════════════════════════════════════════════════
// CONFIRMATION CALL
// ═══════════════════════════════════════════════════════════════

export type ConfirmationCallResult = {
  status: 'initiated' | 'skipped' | 'failed'
  reason?: string
  call_id?: string
  retell_call_id?: string
}

/**
 * Initiate an AI confirmation call for an appointment.
 *
 * The call uses the existing Retell agent with dynamic variables
 * that switch its behavior to a confirmation-focused conversation:
 * - Greet patient by name
 * - State appointment date/time
 * - Ask for confirmation
 * - Handle: confirm, reschedule request, cancel
 */
export async function initiateConfirmationCall(
  supabase: SupabaseClient,
  params: {
    organization_id: string
    appointment_id: string
    lead_id: string
    lead_first_name: string
    appointment_type: string
    appointment_datetime: string
    practice_name: string
  }
): Promise<ConfirmationCallResult> {
  const {
    organization_id,
    appointment_id,
    lead_id,
    lead_first_name,
    appointment_type,
    appointment_datetime,
    practice_name,
  } = params

  // Pre-call compliance check
  const check = await preCallCheck(supabase, lead_id, organization_id)

  if (!check.allowed) {
    logger.info('Confirmation call skipped - pre-call check failed', {
      lead_id,
      appointment_id,
      reason: check.reason,
    })

    // Log the skip in appointment_reminders
    await supabase.from('appointment_reminders').insert({
      organization_id,
      appointment_id,
      lead_id,
      channel: 'voice_confirmation',
      reminder_type: 'confirmation_call',
      status: 'skipped',
      confirmation_status: 'pending',
      error_message: `Pre-call check failed: ${check.reason}`,
      metadata: { skip_reason: check.reason },
    })

    return { status: 'skipped', reason: check.reason }
  }

  // Get the lead record for call initiation
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', lead_id)
    .single()

  if (!lead) {
    return { status: 'failed', reason: 'lead_not_found' }
  }

  // Initiate the call with appointment-specific dynamic variables
  // These variables are injected into the Retell LLM prompt to
  // guide the AI into a confirmation conversation flow
  const result = await initiateOutboundCall(supabase, {
    organization_id,
    lead_id,
    lead: lead as Record<string, unknown>,
    phone: check.phone!,
    agent_type: 'setter', // Use the setter agent for confirmation calls
  })

  if ('error' in result) {
    logger.error('Confirmation call failed', {
      lead_id,
      appointment_id,
      error: result.error,
    })

    await supabase.from('appointment_reminders').insert({
      organization_id,
      appointment_id,
      lead_id,
      channel: 'voice_confirmation',
      reminder_type: 'confirmation_call',
      status: 'failed',
      confirmation_status: 'pending',
      error_message: result.error,
    })

    return { status: 'failed', reason: result.error }
  }

  // Record the reminder and link to the voice call
  await supabase.from('appointment_reminders').insert({
    organization_id,
    appointment_id,
    lead_id,
    channel: 'voice_confirmation',
    reminder_type: 'confirmation_call',
    status: 'sent',
    confirmation_status: 'pending',
    sent_at: new Date().toISOString(),
    external_id: result.retell_call_id,
    voice_call_id: result.call_id,
    metadata: {
      appointment_type,
      appointment_datetime,
      practice_name,
    },
  })

  // Mark the appointment
  await supabase
    .from('appointments')
    .update({ confirmation_call_made: true })
    .eq('id', appointment_id)

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id,
    lead_id,
    activity_type: 'confirmation_call_initiated',
    title: `AI confirmation call initiated for ${appointment_type}`,
    metadata: {
      appointment_id,
      call_id: result.call_id,
      retell_call_id: result.retell_call_id,
    },
  })

  logger.info('Confirmation call initiated', {
    appointment_id,
    call_id: result.call_id,
    retell_call_id: result.retell_call_id,
  })

  return {
    status: 'initiated',
    call_id: result.call_id,
    retell_call_id: result.retell_call_id,
  }
}

// ═══════════════════════════════════════════════════════════════
// POST-CALL CONFIRMATION PROCESSING
// ═══════════════════════════════════════════════════════════════

/**
 * Process the outcome of a confirmation call.
 * Called after processCallEnd() has saved the transcript.
 *
 * Analyzes the call outcome and updates the appointment status.
 */
export async function processConfirmationCallOutcome(
  supabase: SupabaseClient,
  params: {
    call_id: string
    appointment_id: string
    organization_id: string
    lead_id: string
    outcome: 'confirmed' | 'declined' | 'rescheduled' | 'no_response'
  }
): Promise<void> {
  const { call_id, appointment_id, organization_id, lead_id, outcome } = params

  // Update the reminder record
  await supabase
    .from('appointment_reminders')
    .update({
      confirmation_status: outcome,
      response_at: new Date().toISOString(),
    })
    .eq('voice_call_id', call_id)

  // Update the appointment based on outcome
  if (outcome === 'confirmed') {
    await supabase
      .from('appointments')
      .update({
        status: 'confirmed',
        confirmation_received: true,
        confirmed_via: 'voice_call',
        confirmed_at: new Date().toISOString(),
      })
      .eq('id', appointment_id)

    // Log activity
    await supabase.from('lead_activities').insert({
      organization_id,
      lead_id,
      activity_type: 'appointment_confirmed',
      title: 'Appointment confirmed via AI call',
      metadata: { appointment_id, call_id, method: 'voice_call' },
    })
  } else if (outcome === 'rescheduled') {
    await supabase
      .from('appointments')
      .update({
        reschedule_requested: true,
        no_show_risk_score: 30, // Lower risk since they engaged
      })
      .eq('id', appointment_id)

    await supabase.from('lead_activities').insert({
      organization_id,
      lead_id,
      activity_type: 'appointment_reschedule_requested',
      title: 'Reschedule requested during confirmation call',
      metadata: { appointment_id, call_id },
    })
  } else if (outcome === 'declined') {
    await supabase
      .from('appointments')
      .update({
        status: 'canceled',
        no_show_risk_score: 100,
      })
      .eq('id', appointment_id)

    await supabase.from('lead_activities').insert({
      organization_id,
      lead_id,
      activity_type: 'appointment_canceled',
      title: 'Appointment canceled during confirmation call',
      metadata: { appointment_id, call_id },
    })
  } else {
    // no_response — increase risk score
    await supabase
      .from('appointments')
      .update({ no_show_risk_score: 70 })
      .eq('id', appointment_id)
  }

  logger.info('Confirmation call outcome processed', {
    appointment_id,
    call_id,
    outcome,
  })
}
