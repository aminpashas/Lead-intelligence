import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

/**
 * POST /api/reactivation/[id]/upload
 *
 * Accepts CSV text (pre-parsed by client), creates or matches
 * existing leads, and enrolls them into the reactivation campaign.
 */

const uploadSchema = z.object({
  leads: z.array(z.object({
    first_name: z.string().min(1),
    last_name: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip_code: z.string().optional(),
    source_type: z.string().optional(),
    notes: z.string().optional(),
    utm_source: z.string().optional(),
    utm_campaign: z.string().optional(),
  })).min(1).max(2000),
  tag_name: z.string().optional(),
})

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: reactivationId } = await params
  const supabase = await createClient()
  const body = await request.json()
  const parsed = uploadSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get the reactivation campaign
  const { data: reactivation } = await supabase
    .from('reactivation_campaigns')
    .select('*, campaign_id')
    .eq('id', reactivationId)
    .eq('organization_id', profile.organization_id)
    .single()

  if (!reactivation) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  if (!reactivation.campaign_id) {
    return NextResponse.json({ error: 'Campaign has no underlying drip sequence' }, { status: 400 })
  }

  // Get first step delay for enrollment scheduling
  const { data: firstStep } = await supabase
    .from('campaign_steps')
    .select('delay_minutes')
    .eq('campaign_id', reactivation.campaign_id)
    .eq('step_number', 1)
    .single()

  const firstStepDelay = firstStep?.delay_minutes || 0

  const results: Array<{
    row: number
    success: boolean
    action: 'created' | 'matched' | 'enrolled' | 'error'
    error?: string
    lead_id?: string
  }> = []

  let created = 0
  let matched = 0
  let enrolled = 0

  for (let i = 0; i < parsed.data.leads.length; i++) {
    const lead = parsed.data.leads[i]

    try {
      let leadId: string | null = null

      // 1. Try to match existing lead by email or phone
      if (lead.email) {
        const { data: existing } = await supabase
          .from('leads')
          .select('id')
          .eq('organization_id', profile.organization_id)
          .eq('email', lead.email)
          .limit(1)
          .single()

        if (existing) {
          leadId = existing.id
          matched++
        }
      }

      if (!leadId && lead.phone) {
        const cleanPhone = lead.phone.replace(/\D/g, '')
        const { data: existing } = await supabase
          .from('leads')
          .select('id')
          .eq('organization_id', profile.organization_id)
          .or(`phone.eq.${cleanPhone},phone_formatted.eq.+1${cleanPhone}`)
          .limit(1)
          .single()

        if (existing) {
          leadId = existing.id
          matched++
        }
      }

      // 2. If no match, create new lead
      if (!leadId) {
        const { data: newLead, error: leadError } = await supabase
          .from('leads')
          .insert({
            organization_id: profile.organization_id,
            first_name: lead.first_name,
            last_name: lead.last_name || null,
            email: lead.email || null,
            phone: lead.phone || null,
            city: lead.city || null,
            state: lead.state || null,
            zip_code: lead.zip_code || null,
            source_type: lead.source_type || 'other',
            notes: lead.notes || null,
            utm_source: lead.utm_source || 'reactivation_campaign',
            utm_campaign: lead.utm_campaign || reactivation.name,
            status: 'contacted',
            sms_consent: !!lead.phone,
            email_consent: !!lead.email,
            tags: parsed.data.tag_name ? [parsed.data.tag_name] : [],
          })
          .select('id')
          .single()

        if (leadError || !newLead) {
          results.push({ row: i + 1, success: false, action: 'error', error: leadError?.message || 'Create failed' })
          continue
        }

        leadId = newLead.id
        created++
      }

      // 3. Enroll lead into the campaign
      const nextStepAt = new Date(Date.now() + firstStepDelay * 60 * 1000).toISOString()

      const { error: enrollError } = await supabase
        .from('campaign_enrollments')
        .upsert({
          organization_id: profile.organization_id,
          campaign_id: reactivation.campaign_id,
          lead_id: leadId,
          status: 'active',
          current_step: 0,
          next_step_at: nextStepAt,
        }, {
          onConflict: 'campaign_id,lead_id',
          ignoreDuplicates: true,
        })

      if (enrollError) {
        results.push({ row: i + 1, success: false, action: 'error', error: enrollError.message })
        continue
      }

      enrolled++
      results.push({ row: i + 1, success: true, action: leadId ? 'enrolled' : 'created', lead_id: leadId || undefined })
    } catch (err) {
      results.push({
        row: i + 1,
        success: false,
        action: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  // Update reactivation campaign stats
  await supabase
    .from('reactivation_campaigns')
    .update({
      total_uploaded: (reactivation.total_uploaded || 0) + created + matched,
      upload_count: (reactivation.upload_count || 0) + 1,
      last_upload_at: new Date().toISOString(),
    })
    .eq('id', reactivationId)

  // Update underlying campaign enrollment count
  await supabase
    .from('campaigns')
    .update({
      total_enrolled: (reactivation.total_uploaded || 0) + enrolled,
    })
    .eq('id', reactivation.campaign_id)

  return NextResponse.json({
    summary: {
      total: parsed.data.leads.length,
      created,
      matched,
      enrolled,
      failed: parsed.data.leads.length - (created + matched),
    },
    results,
  })
}
