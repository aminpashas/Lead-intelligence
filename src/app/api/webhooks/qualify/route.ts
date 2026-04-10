import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { validateOrgId, validateCustomFields, applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { encryptField } from '@/lib/encryption'

const qualifySchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().max(100).optional(),
  phone: z.string().min(7).max(20),
  email: z.string().email().max(255),
  city: z.string().max(100).optional(),
  state: z.string().max(50).optional(),
  dental_condition: z.string().max(100),
  dental_condition_details: z.string().max(1000).optional(),
  has_dentures: z.boolean().optional(),
  urgency: z.string().max(50),
  financing_interest: z.string().max(50).optional(),
  has_dental_insurance: z.boolean().optional(),
  budget_range: z.string().max(50).optional(),
  source_type: z.string().max(50).optional(),
  utm_source: z.string().max(200).optional(),
  utm_medium: z.string().max(200).optional(),
  utm_campaign: z.string().max(200).optional(),
  utm_content: z.string().max(200).optional(),
  utm_term: z.string().max(200).optional(),
  gclid: z.string().max(200).optional(),
  fbclid: z.string().max(200).optional(),
  landing_page_url: z.string().max(2000).optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
})

export async function POST(request: NextRequest) {
  // Rate limit — stricter for public form (10 req/min)
  const rlError = applyRateLimit(request, RATE_LIMITS.publicForm)
  if (rlError) return rlError

  const body = await request.json()

  // Validate organization exists (UUID format + DB lookup)
  const orgResult = await validateOrgId(new URL(request.url).searchParams.get('org'))
  if (orgResult instanceof NextResponse) return orgResult

  const parsed = qualifySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 })
  }

  // Validate custom_fields size
  const cfError = validateCustomFields(parsed.data.custom_fields)
  if (cfError) return cfError

  // Use anon client — the RPC function is SECURITY DEFINER
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  // Format phone
  let phoneFormatted: string | null = null
  if (parsed.data.phone) {
    const cleaned = parsed.data.phone.replace(/\D/g, '')
    phoneFormatted = cleaned.startsWith('1') ? `+${cleaned}` : `+1${cleaned}`
  }

  try {
    const { data: result, error } = await supabase.rpc('insert_qualified_lead', {
      p_org_id: orgResult.orgId,
      p_first_name: parsed.data.first_name,
      p_last_name: parsed.data.last_name || null,
      p_phone: encryptField(parsed.data.phone) || parsed.data.phone,
      p_phone_formatted: encryptField(phoneFormatted) || phoneFormatted,
      p_email: encryptField(parsed.data.email || null),
      p_city: parsed.data.city || null,
      p_state: parsed.data.state || null,
      p_dental_condition: parsed.data.dental_condition,
      p_dental_condition_details: parsed.data.dental_condition_details || null,
      p_has_dentures: parsed.data.has_dentures ?? null,
      p_urgency: parsed.data.urgency,
      p_financing_interest: parsed.data.financing_interest || null,
      p_has_dental_insurance: parsed.data.has_dental_insurance ?? false,
      p_budget_range: parsed.data.budget_range || null,
      p_source_type: parsed.data.source_type || 'landing_page',
      p_utm_source: parsed.data.utm_source || null,
      p_utm_medium: parsed.data.utm_medium || null,
      p_utm_campaign: parsed.data.utm_campaign || null,
      p_utm_content: parsed.data.utm_content || null,
      p_utm_term: parsed.data.utm_term || null,
      p_gclid: parsed.data.gclid || null,
      p_fbclid: parsed.data.fbclid || null,
      p_landing_page_url: parsed.data.landing_page_url || null,
      p_custom_fields: parsed.data.custom_fields || {},
    })

    if (error) {
      console.error('Qualify RPC error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Return success — scoring happens async later (or via cron)
    // For now return a mock score based on urgency + dental condition
    const urgencyScore: Record<string, number> = { asap: 90, soon: 70, depends: 50, putting_off: 40 }
    const conditionScore: Record<string, number> = { missing_all_both: 85, denture_problems: 80, failing_teeth: 75, missing_multiple: 60, other: 40 }

    const uScore = urgencyScore[parsed.data.urgency] || 50
    const cScore = conditionScore[parsed.data.dental_condition] || 50
    const totalScore = Math.round((uScore * 0.5 + cScore * 0.5))
    const qualification = totalScore >= 75 ? 'hot' : totalScore >= 50 ? 'warm' : totalScore >= 25 ? 'cold' : 'unqualified'

    return NextResponse.json({
      success: true,
      lead_id: result?.lead_id,
      action: result?.action || 'created',
      score: {
        total: totalScore,
        qualification,
        summary: `Lead scored ${totalScore}/100 based on dental condition and urgency.`,
        recommended_action: qualification === 'hot' ? 'Schedule consultation ASAP' : 'Follow up within 24 hours',
      },
    }, { status: result?.action === 'created' ? 201 : 200 })
  } catch (err) {
    console.error('Qualify error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
