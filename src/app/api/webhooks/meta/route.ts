import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { scoreLead } from '@/lib/ai/scoring'
import crypto from 'crypto'

// GET /api/webhooks/meta - Meta webhook verification (required for setup)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const token = searchParams.get('hub.verify_token')
  const challenge = searchParams.get('hub.challenge')

  if (mode === 'subscribe' && token === process.env.WEBHOOK_SECRET) {
    return new NextResponse(challenge, { status: 200 })
  }

  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}

// POST /api/webhooks/meta - Meta Lead Ads webhook
export async function POST(request: NextRequest) {
  const body = await request.json()
  const orgId = new URL(request.url).searchParams.get('org')

  if (!orgId) {
    return NextResponse.json({ error: 'Organization ID required (?org=...)' }, { status: 400 })
  }

  // Verify signature from Meta
  const signature = request.headers.get('x-hub-signature-256')
  if (process.env.WEBHOOK_SECRET && signature) {
    const rawBody = JSON.stringify(body)
    const expected = 'sha256=' + crypto
      .createHmac('sha256', process.env.WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex')

    if (signature !== expected) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  const supabase = createServiceClient()

  // Meta Lead Ads webhook sends events in the `entry` array
  const entries = body.entry || []

  for (const entry of entries) {
    const changes = entry.changes || []

    for (const change of changes) {
      if (change.field !== 'leadgen') continue

      const leadgenData = change.value
      // In production, you'd call the Meta Graph API to fetch lead data
      // For now, handle the payload that comes through
      const formData = leadgenData.field_data || []

      const getValue = (field: string) =>
        formData.find((f: any) => f.name === field)?.values?.[0] || null

      const firstName = getValue('first_name') || getValue('full_name')?.split(' ')[0] || 'Meta Lead'
      const lastName = getValue('last_name') || getValue('full_name')?.split(' ').slice(1).join(' ') || ''
      const email = getValue('email')
      const phone = getValue('phone_number') || getValue('phone')

      let phoneFormatted: string | null = null
      if (phone) {
        const cleaned = phone.replace(/\D/g, '')
        phoneFormatted = cleaned.startsWith('1') ? `+${cleaned}` : `+1${cleaned}`
      }

      // Deduplicate
      if (email || phone) {
        const filters = [
          email ? `email.eq.${email}` : null,
          phone ? `phone.eq.${phone}` : null,
        ].filter(Boolean).join(',')

        const { data: existing } = await supabase
          .from('leads')
          .select('id')
          .eq('organization_id', orgId)
          .or(filters)
          .limit(1)

        if (existing && existing.length > 0) continue
      }

      const { data: defaultStage } = await supabase
        .from('pipeline_stages')
        .select('id')
        .eq('organization_id', orgId)
        .eq('is_default', true)
        .single()

      const { data: lead } = await supabase
        .from('leads')
        .insert({
          organization_id: orgId,
          first_name: firstName,
          last_name: lastName,
          email,
          phone,
          phone_formatted: phoneFormatted,
          source_type: 'meta_ads',
          utm_source: 'facebook',
          utm_medium: 'paid_social',
          utm_campaign: leadgenData.form_name,
          fbclid: leadgenData.fbclid,
          stage_id: defaultStage?.id,
          status: 'new',
          custom_fields: {
            meta_lead_id: leadgenData.leadgen_id,
            meta_form_id: leadgenData.form_id,
            meta_page_id: leadgenData.page_id,
            meta_ad_id: leadgenData.ad_id,
          },
        })
        .select()
        .single()

      if (lead) {
        await supabase.from('lead_activities').insert({
          organization_id: orgId,
          lead_id: lead.id,
          activity_type: 'created',
          title: 'Lead captured from Meta/Facebook Ads',
          metadata: { form_name: leadgenData.form_name },
        })

        // Auto-score
        try {
          const score = await scoreLead(lead)
          await supabase.from('leads').update({
            ai_score: score.total_score,
            ai_qualification: score.qualification,
            ai_score_breakdown: { dimensions: score.dimensions, confidence: score.confidence },
            ai_score_updated_at: new Date().toISOString(),
            ai_summary: score.summary,
          }).eq('id', lead.id)
        } catch { /* non-blocking */ }
      }
    }
  }

  return NextResponse.json({ success: true })
}
