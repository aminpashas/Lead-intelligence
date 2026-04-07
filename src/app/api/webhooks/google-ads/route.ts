import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { scoreLead } from '@/lib/ai/scoring'

// POST /api/webhooks/google-ads - Google Ads lead form webhook
// Google Ads sends lead form extensions data via webhook
export async function POST(request: NextRequest) {
  const body = await request.json()
  const orgId = new URL(request.url).searchParams.get('org')

  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID required (?org=...)' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Google Ads webhook payload structure
  // The exact format depends on the integration (Zapier, direct, etc.)
  // This handles the most common formats
  const leadData = {
    first_name: body.first_name || body.user_column_data?.find((c: any) => c.column_id === 'FULL_NAME')?.string_value?.split(' ')[0] || body.lead_form_name || 'Google Lead',
    last_name: body.last_name || body.user_column_data?.find((c: any) => c.column_id === 'FULL_NAME')?.string_value?.split(' ').slice(1).join(' ') || '',
    email: body.email || body.user_column_data?.find((c: any) => c.column_id === 'EMAIL')?.string_value || null,
    phone: body.phone || body.user_column_data?.find((c: any) => c.column_id === 'PHONE_NUMBER')?.string_value || null,
    city: body.city || body.user_column_data?.find((c: any) => c.column_id === 'CITY')?.string_value || null,
    postal_code: body.zip_code || body.user_column_data?.find((c: any) => c.column_id === 'POSTAL_CODE')?.string_value || null,
  }

  // Format phone
  let phoneFormatted: string | null = null
  if (leadData.phone) {
    const cleaned = leadData.phone.replace(/\D/g, '')
    phoneFormatted = cleaned.startsWith('1') ? `+${cleaned}` : `+1${cleaned}`
  }

  // Deduplicate
  if (leadData.email || leadData.phone) {
    const filters = [
      leadData.email ? `email.eq.${leadData.email}` : null,
      leadData.phone ? `phone.eq.${leadData.phone}` : null,
    ].filter(Boolean).join(',')

    const { data: existing } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', orgId)
      .or(filters)
      .limit(1)

    if (existing && existing.length > 0) {
      return NextResponse.json({ success: true, lead_id: existing[0].id, action: 'duplicate' })
    }
  }

  // Get default stage
  const { data: defaultStage } = await supabase
    .from('pipeline_stages')
    .select('id')
    .eq('organization_id', orgId)
    .eq('is_default', true)
    .single()

  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      organization_id: orgId,
      first_name: leadData.first_name,
      last_name: leadData.last_name,
      email: leadData.email,
      phone: leadData.phone,
      phone_formatted: phoneFormatted,
      zip_code: leadData.postal_code,
      city: leadData.city,
      source_type: 'google_ads',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: body.campaign_name || body.utm_campaign,
      gclid: body.gclid || body.gcl_id,
      stage_id: defaultStage?.id,
      status: 'new',
      custom_fields: {
        google_lead_id: body.lead_id || body.google_key,
        campaign_id: body.campaign_id,
        ad_group_id: body.ad_group_id,
      },
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Log & auto-score
  await supabase.from('lead_activities').insert({
    organization_id: orgId,
    lead_id: lead.id,
    activity_type: 'created',
    title: 'Lead captured from Google Ads',
    metadata: { campaign: body.campaign_name },
  })

  try {
    const score = await scoreLead(lead)
    await supabase.from('leads').update({
      ai_score: score.total_score,
      ai_qualification: score.qualification,
      ai_score_breakdown: { dimensions: score.dimensions, confidence: score.confidence },
      ai_score_updated_at: new Date().toISOString(),
      ai_summary: score.summary,
    }).eq('id', lead.id)
  } catch { /* scoring failure shouldn't block */ }

  return NextResponse.json({ success: true, lead_id: lead.id, action: 'created' }, { status: 201 })
}
