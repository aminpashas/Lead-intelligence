/**
 * SMS Training Console
 *
 * Intercepts inbound SMS from an allowlisted trainer number ONLY when a training
 * session is active or the message is an explicit command (TRAIN/ROLEPLAY/RULE/
 * HELP/STATUS). Anything else falls through to the normal lead pipeline, so a
 * trainer number can still text in as a real patient. Training is opt-in per
 * message. It routes owned messages into a two-mode training state machine:
 *  - ROLEPLAY: AI plays the patient, the trainer practices as coordinator.
 *  - TRAIN (dry-run): trainer texts as a patient, the AI answers as the
 *    coordinator, and the trainer critiques/corrects it.
 *
 * Corrections persist as agency-wide rules (agency_ai_rules) that are injected
 * into every practice's live setter/closer prompt via buildAgencyRulesBlock.
 *
 * Both generation modes reuse the roleplay engine (no live tool execution), so a
 * dry run never fires booking/financing side effects against a real lead.
 */

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SmsTrainingSession, SmsTrainingMode, AIRolePlaySession } from '@/types/database'

/** Constant-time string compare (length-safe) for the training PIN. */
function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}
import {
  generateRolePlayResponse,
  generateRolePlayRetry,
  generateSessionSummary,
  findScenario,
} from '@/lib/ai/roleplay-engine'
import { createAgencyRule } from '@/lib/ai/agency-rules'

// ── Command grammar ─────────────────────────────────────────────
export type ParsedCommand =
  | { kind: 'train'; pin: string | null }
  | { kind: 'roleplay'; pin: string | null; scenario: string | null }
  | { kind: 'rule'; text: string }
  | { kind: 'fix'; guidance: string }
  | { kind: 'save' }
  | { kind: 'done' }
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'text'; text: string }

/** Pure: classify an inbound SMS body by its first token. STOP is NOT an exit. */
export function parseTrainerCommand(body: string): ParsedCommand {
  const trimmed = body.trim()
  const [firstRaw, ...rest] = trimmed.split(/\s+/)
  const first = (firstRaw || '').toLowerCase()
  const remainder = rest.join(' ').trim()

  switch (first) {
    case 'train':
      return { kind: 'train', pin: rest[0] || null }
    case 'roleplay': {
      const pin = rest[0] || null
      const scenario = rest.slice(1).join(' ').trim() || null
      return { kind: 'roleplay', pin, scenario }
    }
    case 'rule':
      return { kind: 'rule', text: remainder }
    case 'fix':
      return { kind: 'fix', guidance: remainder }
    case 'save':
      return { kind: 'save' }
    case 'done':
    case 'exit':
      return { kind: 'done' }
    case 'help':
      return { kind: 'help' }
    case 'status':
      return { kind: 'status' }
    default:
      return { kind: 'text', text: trimmed }
  }
}

/** Best-effort E.164 for US numbers; leaves already-+ numbers as digit-normalized. */
export function normalizeE164(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return '+' + digits.slice(1).replace(/\D/g, '')
  const d = digits.replace(/\D/g, '')
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d.startsWith('1')) return '+' + d
  return '+' + d
}

export function isTrainerNumber(from: string, allowlist: string[]): boolean {
  const target = normalizeE164(from)
  return allowlist.map(normalizeE164).includes(target)
}

// ── Trainer config (allowlist / PIN / reference org) ────────────
export type TrainerConfig = {
  numbers: string[]
  pin: string | null
  referenceOrgId: string | null
}

/**
 * Load trainer allowlist + PIN + reference org from agency_settings, with an
 * env fallback for the number list (SMS_TRAINER_NUMBERS="+1...,+1...").
 * Keys: 'sms_trainer_numbers' (jsonb string[]), 'training_pin' (jsonb string),
 * 'training_reference_org' (jsonb string uuid).
 */
export async function getTrainerConfig(supabase: SupabaseClient): Promise<TrainerConfig> {
  const { data } = await supabase
    .from('agency_settings')
    .select('key, value')
    .in('key', ['sms_trainer_numbers', 'training_pin', 'training_reference_org'])

  const byKey = new Map((data || []).map((r: { key: string; value: unknown }) => [r.key, r.value]))

  const envNumbers = (process.env.SMS_TRAINER_NUMBERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const dbNumbers = Array.isArray(byKey.get('sms_trainer_numbers'))
    ? (byKey.get('sms_trainer_numbers') as string[])
    : []
  const numbers = [...new Set([...dbNumbers, ...envNumbers])]

  const pinRaw = byKey.get('training_pin')
  const pin = typeof pinRaw === 'string' && pinRaw.trim() ? pinRaw.trim() : null

  const refRaw = byKey.get('training_reference_org')
  const referenceOrgId = typeof refRaw === 'string' && refRaw.trim() ? refRaw.trim() : null

  return { numbers, pin, referenceOrgId }
}

/**
 * Resolve the org id used purely to give dry-run/roleplay generation realistic
 * context. Prefers the configured reference org; falls back to the first
 * practice org (agency-wide training still SAVES rules with no org).
 */
export async function resolveReferenceOrg(
  supabase: SupabaseClient,
  configured: string | null
): Promise<string | null> {
  if (configured) return configured
  const { data } = await supabase
    .from('organizations')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data?.id as string) || null
}

// ── Session store ───────────────────────────────────────────────
const IDLE_TTL_MS = 6 * 60 * 60 * 1000 // 6h

/** Load the active session for a phone, lazily ending it if idle past the TTL. */
export async function getActiveSession(
  supabase: SupabaseClient,
  trainerPhone: string
): Promise<SmsTrainingSession | null> {
  const { data } = await supabase
    .from('sms_training_sessions')
    .select('*')
    .eq('trainer_phone', trainerPhone)
    .eq('status', 'active')
    .maybeSingle()

  const session = data as SmsTrainingSession | null
  if (!session) return null

  const idleMs = Date.now() - new Date(session.last_activity_at).getTime()
  if (idleMs > IDLE_TTL_MS) {
    await endSession(supabase, session.id)
    return null
  }
  return session
}

export async function openSession(
  supabase: SupabaseClient,
  params: {
    trainerPhone: string
    mode: SmsTrainingMode
    scenarioKey: string | null
    patientPersona: Record<string, unknown> | null
    referenceOrgId: string | null
    transcript: Array<{ role: 'user' | 'assistant'; content: string }>
  }
): Promise<SmsTrainingSession> {
  const { data } = await supabase
    .from('sms_training_sessions')
    .insert({
      trainer_phone: params.trainerPhone,
      mode: params.mode,
      scenario_key: params.scenarioKey,
      patient_persona: params.patientPersona,
      reference_org_id: params.referenceOrgId,
      transcript: params.transcript,
    })
    .select('*')
    .single()
  return data as SmsTrainingSession
}

/** Append messages to the transcript and bump last_activity_at. */
export async function appendTurn(
  supabase: SupabaseClient,
  session: SmsTrainingSession,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  extra: Partial<Pick<SmsTrainingSession, 'rules_saved'>> = {}
): Promise<SmsTrainingSession> {
  const transcript = [...session.transcript, ...messages]
  const { data } = await supabase
    .from('sms_training_sessions')
    .update({ transcript, last_activity_at: new Date().toISOString(), ...extra })
    .eq('id', session.id)
    .select('*')
    .single()
  return data as SmsTrainingSession
}

export async function endSession(supabase: SupabaseClient, sessionId: string): Promise<void> {
  await supabase
    .from('sms_training_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', sessionId)
}

// ── Orchestrator ────────────────────────────────────────────────
export const HELP_TEXT =
  'Training commands:\n' +
  '• TRAIN <pin> — dry-run: you text as a patient, AI replies as coordinator\n' +
  '• ROLEPLAY <pin> [scenario] — you practice as coordinator, AI plays patient\n' +
  '• FIX <note> — redo AI\'s last reply (dry-run)\n' +
  '• SAVE — save AI\'s last reply as a rule (dry-run)\n' +
  '• RULE <text> — save a durable agency rule\n' +
  '• STATUS / DONE'

const AI_TAG = '🤖 '

/**
 * Handles inbound SMS from an allowlisted trainer number. Returns
 * { handled:false } (webhook falls through to the normal lead pipeline) when
 * `from` is not a trainer, OR when it is a trainer but there's no active session
 * and the message isn't an explicit command — so a trainer number can still text
 * in as a real patient. When handled, `reply` is the text to send back.
 */
export async function handleTrainerSms(
  supabase: SupabaseClient,
  params: { from: string; body: string }
): Promise<{ handled: boolean; reply: string | null }> {
  const config = await getTrainerConfig(supabase)
  if (!isTrainerNumber(params.from, config.numbers)) {
    return { handled: false, reply: null }
  }

  const phone = normalizeE164(params.from)
  const cmd = parseTrainerCommand(params.body)
  const session = await getActiveSession(supabase, phone)

  // ── No active session ──
  if (!session) {
    if (cmd.kind === 'help' || cmd.kind === 'status') return { handled: true, reply: HELP_TEXT }

    if (cmd.kind === 'train' || cmd.kind === 'roleplay') {
      if (config.pin && !timingSafeStrEqual(cmd.pin ?? '', config.pin)) {
        return { handled: true, reply: 'Invalid PIN. Text HELP for commands.' }
      }
      const referenceOrgId = await resolveReferenceOrg(supabase, config.referenceOrgId)
      if (cmd.kind === 'train') {
        await openSession(supabase, {
          trainerPhone: phone, mode: 'dry_run', scenarioKey: null,
          patientPersona: null, referenceOrgId, transcript: [],
        })
        return { handled: true, reply: 'Dry-run started. Text me as a patient — I\'ll reply as the coordinator. DONE to end.' }
      }
      const scenario = findScenario(cmd.scenario || '')
      const opened = await openSession(supabase, {
        trainerPhone: phone, mode: 'roleplay', scenarioKey: scenario.id,
        patientPersona: scenario.patient_persona as unknown as Record<string, unknown>,
        referenceOrgId, transcript: [],
      })
      // AI sends the opening patient line.
      const first = await runRoleplayPatient(supabase, referenceOrgId, opened, scenario)
      await appendTurn(supabase, opened, [{ role: 'assistant', content: first }])
      return { handled: true, reply: `${AI_TAG}[${scenario.name}]\n${first}` }
    }

    if (cmd.kind === 'rule') {
      if (config.pin) return { handled: true, reply: 'Start a session first (TRAIN <pin>) or include your PIN.' }
      if (!cmd.text) return { handled: true, reply: 'Usage: RULE <the guidance to save>' }
      await createAgencyRule(supabase, { text: cmd.text, createdBy: phone })
      return { handled: true, reply: '✓ Saved. Live for all practices on the next message.' }
    }

    // Opt-in training: with no active session and no explicit command
    // (TRAIN/ROLEPLAY/RULE/HELP/STATUS handled above), fall through to the normal
    // lead pipeline so a trainer number can still get real coordinator replies.
    return { handled: false, reply: null }
  }

  // ── Active session ──
  if (cmd.kind === 'done') {
    const summary = await safeSummary(session)
    await endSession(supabase, session.id)
    return { handled: true, reply: `Session ended. ${summary}` }
  }
  if (cmd.kind === 'help') return { handled: true, reply: HELP_TEXT }
  if (cmd.kind === 'status') {
    return { handled: true, reply: `Mode: ${session.mode}${session.scenario_key ? ` (${session.scenario_key})` : ''} · rules saved: ${session.rules_saved}` }
  }
  if (cmd.kind === 'rule') {
    if (!cmd.text) return { handled: true, reply: 'Usage: RULE <the guidance to save>' }
    await createAgencyRule(supabase, { text: cmd.text, createdBy: phone })
    await appendTurn(supabase, session, [], { rules_saved: session.rules_saved + 1 })
    return { handled: true, reply: '✓ Saved. Live for all practices on the next message.' }
  }

  if (session.mode === 'dry_run') return handleDryRunTurn(supabase, session, phone, cmd)
  return handleRoleplayTurn(supabase, session, cmd)
}

function toRoleplaySession(
  session: SmsTrainingSession,
  scenarioName: string | null,
  userRole: 'patient' | 'treatment_coordinator'
): Pick<AIRolePlaySession, 'user_role' | 'agent_target' | 'patient_persona' | 'scenario_description' | 'messages'> {
  return {
    user_role: userRole,
    agent_target: 'setter',
    patient_persona: (session.patient_persona as AIRolePlaySession['patient_persona']) ?? null,
    scenario_description: scenarioName,
    messages: session.transcript.map((m) => ({ role: m.role, content: m.content })) as AIRolePlaySession['messages'],
  }
}

/** ROLEPLAY opening: AI = patient. */
async function runRoleplayPatient(
  supabase: SupabaseClient,
  refOrgId: string | null,
  session: SmsTrainingSession,
  scenario: { name: string }
): Promise<string> {
  const rp = toRoleplaySession(session, scenario.name, 'treatment_coordinator')
  return generateRolePlayResponse(supabase, refOrgId || '', rp)
}

/** ROLEPLAY (AI = patient): trainer texts as coordinator, AI answers as patient. */
async function handleRoleplayTurn(
  supabase: SupabaseClient,
  session: SmsTrainingSession,
  cmd: ParsedCommand
): Promise<{ handled: boolean; reply: string | null }> {
  if (cmd.kind !== 'text') return { handled: true, reply: HELP_TEXT }
  const withUser = await appendTurn(supabase, session, [{ role: 'user', content: cmd.text }])
  const rp = toRoleplaySession(withUser, withUser.scenario_key, 'treatment_coordinator')
  const reply = await generateRolePlayResponse(supabase, withUser.reference_org_id || '', rp)
  await appendTurn(supabase, withUser, [{ role: 'assistant', content: reply }])
  return { handled: true, reply: `${AI_TAG}${reply}` }
}

/** DRY-RUN (AI = coordinator): trainer texts as patient, AI answers as TC; FIX/SAVE act on the last AI reply. */
async function handleDryRunTurn(
  supabase: SupabaseClient,
  session: SmsTrainingSession,
  phone: string,
  cmd: ParsedCommand
): Promise<{ handled: boolean; reply: string | null }> {
  const lastAi = [...session.transcript].reverse().find((m) => m.role === 'assistant')?.content || null

  if (cmd.kind === 'save') {
    if (!lastAi) return { handled: true, reply: 'Nothing to save yet — I haven\'t replied.' }
    await createAgencyRule(supabase, { text: lastAi, createdBy: phone })
    await appendTurn(supabase, session, [], { rules_saved: session.rules_saved + 1 })
    return { handled: true, reply: '✓ Saved that reply as a rule. Live for all practices next message.' }
  }

  if (cmd.kind === 'fix') {
    if (!lastAi) return { handled: true, reply: 'No reply to fix yet.' }
    const rp = toRoleplaySession(session, session.scenario_key, 'patient')
    const revised = await generateRolePlayRetry(supabase, session.reference_org_id || '', rp, lastAi, cmd.guidance)
    // Replace the last assistant message in the transcript.
    const idx = session.transcript.map((m) => m.role).lastIndexOf('assistant')
    const nextTranscript = session.transcript.slice()
    if (idx >= 0) nextTranscript[idx] = { role: 'assistant', content: revised }
    await supabase
      .from('sms_training_sessions')
      .update({ transcript: nextTranscript, last_activity_at: new Date().toISOString() })
      .eq('id', session.id)
    return { handled: true, reply: `${AI_TAG}${revised}` }
  }

  if (cmd.kind !== 'text') return { handled: true, reply: HELP_TEXT }
  const withUser = await appendTurn(supabase, session, [{ role: 'user', content: cmd.text }])
  const rp = toRoleplaySession(withUser, withUser.scenario_key, 'patient')
  const reply = await generateRolePlayResponse(supabase, withUser.reference_org_id || '', rp)
  await appendTurn(supabase, withUser, [{ role: 'assistant', content: reply }])
  return { handled: true, reply: `${AI_TAG}${reply}` }
}

async function safeSummary(session: SmsTrainingSession): Promise<string> {
  try {
    return await generateSessionSummary({
      ...(session as unknown as AIRolePlaySession),
      messages: session.transcript.map((m) => ({
        role: m.role, content: m.content, acting_as: m.role === 'user' ? 'treatment_coordinator' : 'patient',
      })) as AIRolePlaySession['messages'],
    } as AIRolePlaySession)
  } catch {
    return `You saved ${session.rules_saved} rule(s).`
  }
}
