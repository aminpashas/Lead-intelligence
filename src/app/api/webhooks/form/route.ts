import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { webhookLeadSchema } from '@/lib/validators/lead'
import { scoreLead } from '@/lib/ai/scoring'
import { enrichLead } from '@/lib/enrichment'
import { verifyWebhookSignature, validateOrgId, getRawBodyAndParsed, validateCustomFields, applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { encryptLeadPII, searchHash } from '@/lib/encryption'
import { auditPHIWrite } from '@/lib/hipaa-audit'

// POST /api/webhooks/form - Universal form webhook
// Supports: Custom forms, Typeform, JotForm, Google Forms, landing pages
export async function POST(request: NextRequest) {
  // Rate limit
  const rlError = applyRateLimit(request, RATE_LIMITS.webhook)
  if (rlError) return rlError

  // Read raw body for signature verification (must be before .json())
  const { rawBody, parsed: body } = await getRawBodyAndParsed(request)

  // Verify webhook signature — MANDATORY
  const sigError = verifyWebhookSignature(
    rawBody,
    request.headers.get('x-webhook-signature')
  )
  if (sigError) return sigError

  // Validate organization exists
  const orgResult = await validateOrgId(
    new URL(request.url).searchParams.get('org') ||
    request.headers.get('x-organization-id')
  )
  if (orgResult instanceof NextResponse) return orgResult

  const parsed = webhookLeadSchema.safeParse(body as Record<string, unknown>)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid lead data', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  // Validate custom_fields size
  const cfError = validateCustomFields(parsed.data.custom_fields as Record<string, unknown> | undefined)
  if (cfError) return cfError

  const supabase = createServiceClient()

  // Check for duplicate (same email or phone in org) using search hashes
  if (parsed.data.email || parsed.data.phone) {
    const emailHash = parsed.data.email ? searchHash(parsed.data.email) : null
    const phoneHash = parsed.data.phone ? searchHash(parsed.data.phone) : null

    const { data: existing } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', orgResult.orgId)
      .or(
        [
          emailHash ? `email_hash.eq.${emailHash}` : null,
          phoneHash ? `phone_hash.eq.${phoneHash}` : null,
          // Fallback for pre-encryption leads
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
        .update(encryptLeadPII({
          ...parsed.data,
          updated_at: new Date().toISOString(),
        }))
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
    .eq('organization_id', orgResult.orgId)
    .eq('is_default', true)
    .single()

  // Format phone
  let phoneFormatted: string | undefined
  if (parsed.data.phone) {
    const cleaned = parsed.data.phone.replace(/\D/g, '')
    phoneFormatted = cleaned.startsWith('1') ? `+${cleaned}` : `+1${cleaned}`
  }

  // Capture IP address for geolocation enrichment
  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    null

  // Create lead with PII encryption
  const leadData = encryptLeadPII({
    organization_id: orgResult.orgId,
    first_name: parsed.data.first_name || 'Unknown',
    last_name: parsed.data.last_name,
    email: parsed.data.email,
    phone: parsed.data.phone,
    phone_formatted: phoneFormatted,
    ip_address: ipAddress,
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
    // TCPA: Consent must be explicitly granted via form checkbox, not implied by providing contact info
    sms_consent: parsed.data.sms_consent === true,
    sms_consent_at: parsed.data.sms_consent ? new Date().toISOString() : null,
    sms_consent_source: parsed.data.sms_consent ? 'form' : null,
    email_consent: parsed.data.email_consent === true,
    email_consent_at: parsed.data.email_consent ? new Date().toISOString() : null,
    email_consent_source: parsed.data.email_consent ? 'form' : null,
  })

  const { data: lead, error } = await supabase
    .from('leads')
    .insert(leadData)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Log activity + HIPAA audit
  await supabase.from('lead_activities').insert({
    organization_id: orgResult.orgId,
    lead_id: lead.id,
    activity_type: 'created',
    title: 'Lead captured via form webhook',
    metadata: { source_type: parsed.data.source_type, utm_source: parsed.data.utm_source },
  })

  auditPHIWrite(
    { supabase, organizationId: orgResult.orgId, actorType: 'webhook' },
    'lead',
    lead.id,
    'PHI ingested via form webhook (encrypted at rest)',
  )

  // Auto-enrich the lead asynchronously (before scoring for better data)
  try {
    await enrichLead(supabase, lead)
  } catch {
    // Enrichment failure shouldn't block lead creation
  }

  // Auto-score the lead asynchronously (now with enrichment data available)
  try {
    const scoreResult = await scoreLead(lead, supabase)
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

  // Speed-to-lead: AI auto-outreach to new leads (non-blocking)
  try {
    const { triggerSpeedToLead } = await import('@/lib/autopilot/speed-to-lead')
    await triggerSpeedToLead(supabase, lead.id, orgResult.orgId)
  } catch {
    // Speed-to-lead failure shouldn't block lead creation
  }

  return NextResponse.json({
    success: true,
    lead_id: lead.id,
    action: 'created',
  }, { status: 201 })
}
