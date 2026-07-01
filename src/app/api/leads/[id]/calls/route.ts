import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { buildManualCallRows } from '@/lib/timeline/manual-call'

const logCallSchema = z.object({
  direction: z.enum(['inbound', 'outbound']),
  duration_seconds: z.number().int().min(0).max(86_400).default(0),
  outcome: z
    .enum([
      'appointment_booked', 'callback_requested', 'interested', 'not_interested',
      'wrong_number', 'do_not_call', 'voicemail_left', 'no_answer',
      'technical_failure', 'transferred',
    ])
    .nullish()
    .transform((v) => v ?? null),
  notes: z.string().max(2000).nullish().transform((v) => v ?? null),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id')
    .single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = logCallSchema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // Scope the lead to the caller's org (defense-in-depth beyond RLS).
  const { data: lead } = await supabase
    .from('leads')
    .select('id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()
  if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

  const { voiceCall, activity } = buildManualCallRows({
    orgId,
    leadId: lead.id,
    userId: profile.id,
    direction: parsed.data.direction,
    outcome: parsed.data.outcome,
    durationSeconds: parsed.data.duration_seconds,
    notes: parsed.data.notes,
    nowIso: new Date().toISOString(),
  })

  const { data: call, error: callError } = await supabase
    .from('voice_calls')
    .insert(voiceCall)
    .select('id')
    .single()
  if (callError || !call) {
    return NextResponse.json({ error: 'Failed to log call' }, { status: 500 })
  }

  await supabase.from('lead_activities').insert(activity)
  await supabase.from('leads').update({ last_contacted_at: new Date().toISOString() }).eq('id', lead.id)

  return NextResponse.json({ ok: true, call_id: call.id })
}
