import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { webhookLeadSchema } from '@/lib/validators/lead'
import { scoreLead } from '@/lib/ai/scoring'
import crypto from 'crypto'

// POST /api/webhooks/form - Universal form webhook
// Supports: Custom forms, Typeform, JotForm, Google Forms, landing pages
export async function POST(request: NextRequest) {
  const body = await request.json()

  // Verify webhook signature if provided
  const signature = request.headers.get('x-webhook-signature')
  if (process.env.WEBHOOK_SECRET && signature) {
    const expected = crypto
      .createHmac('sha256', process.env.WEBHOOK_SECRET)
      .update(JSON.stringify(body))
      .digest('hex')

    if (signature !== expected) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  // Extract organization ID from query param or header
  const orgId = new URL(request.url).searchParams.get('org') ||
    request.headers.get('x-organization-id')

  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID required' }, { status: 400 })
  }

  const parsed = webhookLeadSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid lead data', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const supabase = createServiceClient()

  // Check for duplicate (same email or phone in org)
  if (parsed.data.email || parsed.data.phone) {
    const { data: existing } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', orgId)
      .or(
        [
          parsed.data.email ? `email.eq.${parsed.data.email}` : null,
          parsed.data.phone ? `phone.eq.${parsed.data.phone}` : null,
        ]
          .filter(Boolean)
          .join(',')
      )
      .limit(1)

    if (existing && existing.length > 0) {
      // Update existing lead instead of creating duplicate
      await supabase
        .from('leads')
        .update({
          ...parsed.data,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing[0].id)

      return NextResponse.json({
        success: true,
        lead_id: existing[0].id,
        action: 'updated',
      })
    }
  }

  // Get default stage
  const { data: defaultStage } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('organization_id', orgId)
    .eq('is_default', true)
    .single()

  // Format phone
  let phoneFormatted: string | undefined
  if (parsed.data.phone) {
    const cleaned = parsed.data.phone.replace(/\D/g, '')
    phoneFormatted = cleaned.startsWith('1') ? `+${cleaned}` : `+1${cleaned}`
  }

  // Create lead
  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      organization_id: orgId,
      first_name: parsed.data.first_name || 'Unknown',
      last_name: parsed.data.last_name,
      email: parsed.data.email,
      phone: parsed.data.phone,
      phone_formatted: phoneFormatted,
      source_type: parsed.data.source_type || 'website_form',
      utm_source: parsed.data.utm_source,
      utm_medium: parsed.data.utm_medium,
      utm_campaign: parsed.data.utm_campaign,
      utm_content: parsed.data.utm_content,
      utm_term: parsed.data.utm_term,
      gclid: parsed.data.gclid,
      fbclid: parsed.data.fbclid,
      landing_page_url: parsed.data.landing_page_url,
      dental_condition: parsed.data.dental_condition as any,
      notes: parsed.data.notes,
      custom_fields: parsed.data.custom_fields || {},
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
    title: 'Lead captured via form webhook',
    metadata: { source_type: parsed.data.source_type, utm_source: parsed.data.utm_source },
  })

  // Auto-score the lead asynchronously
  try {
    const scoreResult = await scoreLead(lead)
    await supabase
      .from('leads')
      .update({
        ai_score: scoreResult.total_score,
        ai_qualification: scoreResult.qualification,
        ai_score_breakdown: { dimensions: scoreResult.dimensions, confidence: scoreResult.confidence },
        ai_score_updated_at: new Date().toISOString(),
        ai_summary: scoreResult.summary,
      })
      .eq('id', lead.id)
  } catch {
    // Scoring failure shouldn't block lead creation
  }

  return NextResponse.json({
    success: true,
    lead_id: lead.id,
    action: 'created',
  }, { status: 201 })
}
