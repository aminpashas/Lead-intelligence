/**
 * Backfill voice_calls from Retell call history.
 *
 * Historically the events webhook only UPDATED pre-registered voice_calls
 * rows and matched leads by plaintext phone against encrypted columns, so
 * live calls (SIP-trunk inbound especially) left no CRM record. Retell keeps
 * the full call log — this pulls every call and inserts the missing rows,
 * linked to leads via the deterministic phone_hash.
 *
 * Idempotent: skips calls whose retell_call_id already exists.
 *
 * Usage:
 *   npx tsx scripts/backfill-voice-calls.ts           # dry run (default)
 *   npx tsx scripts/backfill-voice-calls.ts --apply   # write rows
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { searchHash } from '../src/lib/encryption'

const APPLY = process.argv.includes('--apply')

function req(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`Missing env: ${name}`); process.exit(1) }
  return v
}

const RETELL_API_KEY = req('RETELL_API_KEY')
const supabase = createClient(
  req('NEXT_PUBLIC_SUPABASE_URL'),
  req('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { autoRefreshToken: false, persistSession: false } },
)

type RetellCall = {
  call_id: string
  direction?: string
  from_number?: string
  to_number?: string
  call_status?: string
  start_timestamp?: number
  end_timestamp?: number
  transcript?: string
  recording_url?: string
  disconnection_reason?: string
  call_analysis?: Record<string, unknown>
  call_cost?: { total_duration_seconds?: number }
  metadata?: Record<string, unknown>
}

async function listAllCalls(): Promise<RetellCall[]> {
  const calls: RetellCall[] = []
  let paginationKey: string | undefined
  for (;;) {
    const res = await fetch('https://api.retellai.com/v2/list-calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RETELL_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ limit: 1000, ...(paginationKey ? { pagination_key: paginationKey } : {}) }),
    })
    if (!res.ok) throw new Error(`Retell list-calls failed: ${res.status} ${await res.text()}`)
    const batch = (await res.json()) as RetellCall[]
    calls.push(...batch)
    if (batch.length < 1000) break
    paginationKey = batch[batch.length - 1].call_id
  }
  return calls
}

function phoneVariants(raw: string): string[] {
  const clean = raw.replace(/[^+0-9]/g, '')
  const digits = clean.replace(/^\+1/, '').replace(/\D/g, '')
  return [...new Set([clean, digits, `+1${digits}`])]
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'dry run'}`)

  const calls = await listAllCalls()
  console.log(`Retell calls fetched: ${calls.length}`)

  const { data: orgs } = await supabase
    .from('organizations')
    .select('id, name, voice_outbound_caller_id')
  const orgByNumber = new Map(
    (orgs || [])
      .filter(o => o.voice_outbound_caller_id)
      .map(o => [o.voice_outbound_caller_id as string, o]),
  )

  let inserted = 0, skippedExisting = 0, skippedUnresolved = 0

  for (const call of calls) {
    const { data: existing } = await supabase
      .from('voice_calls').select('id')
      .eq('retell_call_id', call.call_id).maybeSingle()
    if (existing) { skippedExisting++; continue }

    const direction = call.direction === 'outbound' ? 'outbound' : 'inbound'
    const patientNumber = direction === 'inbound' ? call.from_number : call.to_number
    const practiceNumber = direction === 'inbound' ? call.to_number : call.from_number

    // Org: metadata first, then practice-number mapping.
    let orgId = (call.metadata?.organization_id as string) || null
    if (!orgId && practiceNumber) {
      orgId = orgByNumber.get(practiceNumber.replace(/[^+0-9]/g, ''))?.id || null
    }

    // Lead: metadata first, then phone_hash.
    let leadId = (call.metadata?.lead_id as string) || null
    if (!leadId && orgId && patientNumber) {
      const hashes = phoneVariants(patientNumber).map(p => searchHash(p)).filter(Boolean) as string[]
      const { data: lead } = await supabase
        .from('leads').select('id')
        .eq('organization_id', orgId)
        .in('phone_hash', hashes)
        .limit(1).maybeSingle()
      leadId = lead?.id || null
    }

    if (!orgId || !leadId) {
      skippedUnresolved++
      console.log(`  unresolved: ${call.call_id} ${direction} ${patientNumber ?? '?'} (org=${orgId ?? 'null'})`)
      continue
    }

    const { data: conv } = await supabase
      .from('conversations').select('id')
      .eq('organization_id', orgId)
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()

    const analysis = call.call_analysis || {}
    const duration = call.call_cost?.total_duration_seconds
      ?? (call.start_timestamp && call.end_timestamp
        ? Math.round((call.end_timestamp - call.start_timestamp) / 1000)
        : 0)

    const row = {
      organization_id: orgId,
      lead_id: leadId,
      conversation_id: conv?.id || null,
      direction,
      // voice_calls_status_check allows: initiated|ringing|in_progress|
      // completed|no_answer|busy|failed|voicemail|canceled
      status: call.call_status === 'ended' ? 'completed'
        : call.call_status === 'not_connected' ? 'failed'
        : 'completed',
      retell_call_id: call.call_id,
      from_number: call.from_number || null,
      to_number: call.to_number || null,
      started_at: call.start_timestamp ? new Date(call.start_timestamp).toISOString() : null,
      ended_at: call.end_timestamp ? new Date(call.end_timestamp).toISOString() : null,
      duration_seconds: duration,
      recording_url: call.recording_url || null,
      transcript: (call.transcript || '').slice(0, 50000) || null,
      transcript_summary: (analysis.call_summary as string) || null,
      outcome: analysis.call_successful ? 'interested' : (call.disconnection_reason || null),
      consent_verified: true,
      metadata: {
        ...(call.metadata || {}),
        call_analysis: analysis,
        disconnection_reason: call.disconnection_reason || null,
        backfilled_at: new Date().toISOString(),
      },
    }

    if (APPLY) {
      const { error } = await supabase.from('voice_calls').insert(row)
      if (error) {
        console.error(`  INSERT FAILED ${call.call_id}:`, error.message)
        continue
      }
    }
    inserted++
    console.log(`  ${APPLY ? 'inserted' : 'would insert'}: ${call.call_id} ${direction} lead=${leadId} ${duration}s`)
  }

  console.log(`\nDone. inserted=${inserted} existing=${skippedExisting} unresolved=${skippedUnresolved}`)
}

main().catch(err => { console.error(err); process.exit(1) })
