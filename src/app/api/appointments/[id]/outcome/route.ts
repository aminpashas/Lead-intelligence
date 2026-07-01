import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { outcomeToLeadStatus } from '@/lib/appointments/outcome'
import { z } from 'zod'

const schema = z.object({
  outcome: z.enum(['treatment_accepted','deposit_paid','considering','declined','referred_out','no_decision']),
  reason: z.enum(['price','financing','timing','second_opinion','medical','spouse_partner','other']).optional(),
  quoted_value_cents: z.number().int().min(0).max(100_000_00).optional(),
  notes: z.string().max(5000).optional(),
  follow_up_at: z.string().optional(), // ISO
})

// POST /api/appointments/[id]/outcome — record a consult outcome (marks "showed")
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const parsed = schema.safeParse(await request.json())
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data: profile } = await supabase.from('user_profiles').select('id').single()
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // BOLA: appointment must belong to this org.
  const { data: appt, error: apptErr } = await supabase
    .from('appointments')
    .update({
      status: 'completed',
      consult_outcome: parsed.data.outcome,
      consult_outcome_reason: parsed.data.outcome === 'declined' ? (parsed.data.reason ?? null) : null,
      quoted_value_cents: parsed.data.quoted_value_cents ?? null,
      outcome_notes: parsed.data.notes ?? null,
      outcome_follow_up_at: parsed.data.follow_up_at ?? null,
      outcome_recorded_at: new Date().toISOString(),
      outcome_recorded_by: profile.id,
      outcome_review_pending: false,
    })
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('*, lead:leads(id, first_name, last_name)')
    .single()

  if (apptErr || !appt) {
    return NextResponse.json({ error: apptErr?.message || 'Not found' }, { status: apptErr ? 500 : 404 })
  }

  const lead = appt.lead as { id: string } | null
  if (lead) {
    await supabase.from('leads').update({ status: outcomeToLeadStatus(parsed.data.outcome) }).eq('id', lead.id)
    await supabase.from('lead_activities').insert({
      organization_id: orgId,
      lead_id: lead.id,
      user_id: profile.id,
      activity_type: 'consult_outcome_recorded',
      title: `Consult outcome: ${parsed.data.outcome.replace(/_/g, ' ')}`,
      description: parsed.data.notes ?? null,
      metadata: {
        appointment_id: id,
        outcome: parsed.data.outcome,
        reason: parsed.data.reason ?? null,
        quoted_value_cents: parsed.data.quoted_value_cents ?? null,
      },
    })
  }

  return NextResponse.json({ appointment: appt })
}
