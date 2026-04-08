import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { scoreLead } from '@/lib/ai/scoring'
import { z } from 'zod'

const qualifySchema = z.object({
  // Contact
  first_name: z.string().min(1),
  last_name: z.string().optional(),
  phone: z.string().min(7),
  email: z.string().email().optional().or(z.literal('')),
  city: z.string().optional(),
  state: z.string().optional(),

  // Dental qualification
  dental_condition: z.string(),
  dental_condition_details: z.string().optional(),
  has_dentures: z.boolean().optional(),
  urgency: z.string(), // 'asap', '1_3_months', '6_months', 'researching'

  // Financial
  financing_interest: z.string().optional(),
  has_dental_insurance: z.boolean().optional(),
  insurance_provider: z.string().optional(),
  budget_range: z.string().optional(),

  // Source tracking
  source_type: z.string().optional(),
  utm_source: z.string().optional(),
  utm_medium: z.string().optional(),
  utm_campaign: z.string().optional(),
  utm_content: z.string().optional(),
  utm_term: z.string().optional(),
  gclid: z.string().optional(),
  fbclid: z.string().optional(),
  landing_page_url: z.string().optional(),
})

// POST /api/webhooks/qualify - Qualification form submission
// Returns the AI score to the client (unlike /api/webhooks/form)
export async function POST(request: NextRequest) {
  const body = await request.json()
  const orgId = new URL(request.url).searchParams.get('org')

  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID required' }, { status: 400 })
  }

  const parsed = qualifySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const supabase = createServiceClient()

  // Format phone for Twilio
  let phoneFormatted: string | null = null
  if (parsed.data.phone) {
    const cleaned = parsed.data.phone.replace(/\D/g, '')
    phoneFormatted = cleaned.startsWith('1') ? `+${cleaned}` : `+1${cleaned}`
  }

  // Check for existing lead (dedupe)
  if (parsed.data.email || parsed.data.phone) {
    const filters = [
      parsed.data.email ? `email.eq.${parsed.data.email}` : null,
      phoneFormatted ? `phone_formatted.eq.${phoneFormatted}` : null,
    ].filter(Boolean).join(',')

    const { data: existing } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', orgId)
      .or(filters)
      .limit(1)

    if (existing && existing.length > 0) {
      // Update existing lead with new qualification data
      await supabase.from('leads').update({
        dental_condition: parsed.data.dental_condition,
        dental_condition_details: parsed.data.dental_condition_details,
        has_dentures: parsed.data.has_dentures,
        financing_interest: parsed.data.financing_interest,
        has_dental_insurance: parsed.data.has_dental_insurance,
        insurance_provider: parsed.data.insurance_provider,
        budget_range: parsed.data.budget_range,
        custom_fields: { urgency: parsed.data.urgency },
      }).eq('id', existing[0].id)

      // Re-score
      const { data: lead } = await supabase.from('leads').select('*').eq('id', existing[0].id).single()
      if (lead) {
        try {
          const score = await scoreLead(lead)
          await supabase.from('leads').update({
            ai_score: score.total_score,
            ai_qualification: score.qualification,
            ai_score_breakdown: { dimensions: score.dimensions, confidence: score.confidence },
            ai_score_updated_at: new Date().toISOString(),
            ai_summary: score.summary,
          }).eq('id', existing[0].id)

          return NextResponse.json({
            success: true,
            lead_id: existing[0].id,
            action: 'updated',
            score: {
              total: score.total_score,
              qualification: score.qualification,
              summary: score.summary,
              recommended_action: score.recommended_action,
            },
          })
        } catch {
          return NextResponse.json({ success: true, lead_id: existing[0].id, action: 'updated', score: null })
        }
      }
    }
  }

  // Get default stage
  const { data: defaultStage } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('organization_id', orgId)
    .eq('is_default', true)
    .single()

  // Create new lead
  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      organization_id: orgId,
      first_name: parsed.data.first_name,
      last_name: parsed.data.last_name || null,
      email: parsed.data.email || null,
      phone: parsed.data.phone,
      phone_formatted: phoneFormatted,
      city: parsed.data.city || null,
      state: parsed.data.state || null,
      dental_condition: parsed.data.dental_condition as any,
      dental_condition_details: parsed.data.dental_condition_details || null,
      has_dentures: parsed.data.has_dentures ?? null,
      financing_interest: parsed.data.financing_interest as any || null,
      has_dental_insurance: parsed.data.has_dental_insurance ?? null,
      insurance_provider: parsed.data.insurance_provider || null,
      budget_range: parsed.data.budget_range as any || null,
      source_type: parsed.data.source_type || 'landing_page',
      utm_source: parsed.data.utm_source || null,
      utm_medium: parsed.data.utm_medium || null,
      utm_campaign: parsed.data.utm_campaign || null,
      utm_content: parsed.data.utm_content || null,
      utm_term: parsed.data.utm_term || null,
      gclid: parsed.data.gclid || null,
      fbclid: parsed.data.fbclid || null,
      landing_page_url: parsed.data.landing_page_url || null,
      custom_fields: { urgency: parsed.data.urgency },
      stage_id: defaultStage?.id,
      status: 'new',
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Log activity
  await supabase.from('lead_activities').insert({
    organization_id: orgId,
    lead_id: lead.id,
    activity_type: 'created',
    title: 'Lead qualified via intake form',
    metadata: {
      source: parsed.data.source_type || 'landing_page',
      urgency: parsed.data.urgency,
      dental_condition: parsed.data.dental_condition,
    },
  })

  // Score the lead and return result
  try {
    const score = await scoreLead(lead)
    await supabase.from('leads').update({
      ai_score: score.total_score,
      ai_qualification: score.qualification,
      ai_score_breakdown: { dimensions: score.dimensions, confidence: score.confidence },
      ai_score_updated_at: new Date().toISOString(),
      ai_summary: score.summary,
    }).eq('id', lead.id)

    return NextResponse.json({
      success: true,
      lead_id: lead.id,
      action: 'created',
      score: {
        total: score.total_score,
        qualification: score.qualification,
        summary: score.summary,
        recommended_action: score.recommended_action,
      },
    }, { status: 201 })
  } catch {
    // Return success even if scoring fails
    return NextResponse.json({
      success: true,
      lead_id: lead.id,
      action: 'created',
      score: null,
    }, { status: 201 })
  }
}
