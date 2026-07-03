import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { buildManualCallRows, buildLeadCapturePatch } from '@/lib/timeline/manual-call'
import type { BudgetRange } from '@/types/database'

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
  // Structured discovery-call capture (all optional).
  budget_range: z
    .enum(['under_10k', '10k_15k', '15k_20k', '20k_25k', '25k_30k', 'over_30k', 'unknown'])
    .nullish()
    .transform((v) => v ?? null),
  testimonial_sent: z.boolean().default(false),
  pain_points: z.string().max(2000).nullish().transform((v) => v ?? null),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'id')
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
    .select('id, personality_profile')
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
    testimonialSent: parsed.data.testimonial_sent,
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

  // Fold structured capture (budget, pain points) into the lead alongside the
  // contact-timestamp bump, so it's a single update.
  const capturePatch = buildLeadCapturePatch({
    budgetRange: parsed.data.budget_range as BudgetRange | null,
    painPoints: parsed.data.pain_points,
    currentProfile: (lead.personality_profile as Record<string, unknown> | null) ?? null,
  })
  await supabase
    .from('leads')
    .update({ last_contacted_at: new Date().toISOString(), ...capturePatch })
    .eq('id', lead.id)

  return NextResponse.json({ ok: true, call_id: call.id })
}
