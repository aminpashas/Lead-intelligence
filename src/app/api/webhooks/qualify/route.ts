import { NextRequest, NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { validateOrgId, validateCustomFields, applyDistributedRateLimit } from '@/lib/webhooks/verify'
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
  const rlError = await applyDistributedRateLimit(request, RATE_LIMITS.publicForm, 'qualify')
  if (rlError) return rlError

  // This is a public, browser-submitted form (no client secret possible), so a
  // shared HMAC like /api/webhooks/form is not an option — the token would sit in
  // the page source. The abuse controls that DO apply here:
  //   1. the per-IP rate limiter above,
  //   2. an optional Origin/Referer allowlist (QUALIFY_ALLOWED_ORIGINS) that
  //      blocks cross-site browser submits,
  //   3. a per-org 24h insertion cap (below) that bounds a distributed / IP-
  //      rotating flood, and
  //   4. the invariant that THIS ROUTE SETS NO CONSENT FLAGS — an injected lead
  //      cannot trigger SMS/email/voice (all downstream sends are consent-gated).
  //      Do not add sms_consent/email_consent writes here without adding a real
  //      anti-automation control (e.g. Cloudflare Turnstile).
  const allowedOrigins = process.env.QUALIFY_ALLOWED_ORIGINS
  if (allowedOrigins) {
    const allow = allowedOrigins.split(',').map((o) => o.trim()).filter(Boolean)
    // Prefer Origin; fall back to the Referer's origin (some embed contexts strip
    // Origin on same-site navigations but still send Referer).
    const origin = request.headers.get('origin')
      || (() => { try { return new URL(request.headers.get('referer') || '').origin } catch { return null } })()
    if (origin && !allow.includes(origin)) {
      return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 })
    }
    // A browser that sends neither Origin nor Referer while an allowlist is
    // configured is treated as disallowed (fail-closed once the operator opts in).
    if (!origin) {
      return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 })
    }
  }

  const body = await request.json()

  // Validate organization exists (UUID format + DB lookup)
  const orgResult = await validateOrgId(new URL(request.url).searchParams.get('org'))
  if (orgResult instanceof NextResponse) return orgResult

  // Per-org 24h insertion cap — bounds a distributed flood that slips past the
  // per-IP limiter. Generous by default so real landing-page traffic is never
  // blocked; tune via QUALIFY_ORG_DAILY_CAP. Fail-open on count error (never drop
  // a real lead because the guard query hiccuped).
  const dailyCap = Number(process.env.QUALIFY_ORG_DAILY_CAP ?? 1000)
  if (Number.isFinite(dailyCap) && dailyCap > 0) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const guard = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
    const { count } = await guard
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgResult.orgId)
      .eq('source_type', 'landing_page')
      .gte('created_at', since)
    if (typeof count === 'number' && count >= dailyCap) {
      console.warn('[qualify] org daily cap reached', { org: orgResult.orgId, count, dailyCap })
      return NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    }
  }

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

    const leadId = result?.lead_id
    const isNew = result?.action === 'created'

    // ── Async post-processing (non-blocking) ──
    // Run full enrichment + AI scoring pipeline after responding to the caller.
    // Only runs on newly created leads; duplicate form submissions skip re-processing.
    //
    // Uses `after()` (not a detached `(async()=>{})()` IIFE): on Vercel the
    // serverless invocation is suspended once the response flushes, which can
    // kill a floating promise mid-flight. `after()` keeps the invocation alive
    // until this background work completes.
    if (leadId && isNew) {
      after(async () => {
        try {
          // Load the full lead record needed by enrichLead
          const { data: lead } = await supabase
            .from('leads')
            .select('*')
            .eq('id', leadId)
            .single()

          if (!lead) return

          // Step 1: Enrich — email validation, phone validation, IP geo, credit prequal
          const { enrichLead } = await import('@/lib/enrichment')
          await enrichLead(supabase, lead)

          // Step 2: Reload with enrichment data, then run 8-dimension AI scoring
          const { data: enrichedLead } = await supabase
            .from('leads')
            .select('*')
            .eq('id', leadId)
            .single()

          if (!enrichedLead) return

          const { scoreLead } = await import('@/lib/ai/scoring')
          const scoreResult = await scoreLead(enrichedLead, supabase)

          await supabase
            .from('leads')
            .update({
              ai_score: scoreResult.total_score,
              ai_qualification: scoreResult.qualification,
              ai_score_breakdown: {
                dimensions: scoreResult.dimensions,
                confidence: scoreResult.confidence,
              },
              ai_score_updated_at: new Date().toISOString(),
              ai_summary: scoreResult.summary,
            })
            .eq('id', leadId)

          // Step 3: Speed-to-lead AI first outreach. Runs AFTER scoring so the
          // setter agent has ai_score/ai_qualification in context. Isolated in
          // its own try/catch so an outreach failure can't undo the score.
          // Internally gated by autopilot config (must be enabled), per-lead
          // consent flags, and TCPA quiet hours — nothing sends unless allowed.
          try {
            const { triggerSpeedToLead } = await import('@/lib/autopilot/speed-to-lead')
            await triggerSpeedToLead(supabase, leadId, orgResult.orgId)
          } catch (err) {
            console.warn('[qualify] Speed-to-lead error:', err instanceof Error ? err.message : err)
          }
        } catch (err) {
          // Non-blocking — log but never surface to the form submitter
          console.warn('[qualify] Post-processing error:', err instanceof Error ? err.message : err)
        }
      })
    }

    // Return immediately with a provisional score so the form response is instant.
    // The real 8-dimension AI score + credit prequal is persisted asynchronously above.
    const urgencyScore: Record<string, number> = { asap: 90, soon: 70, depends: 50, putting_off: 40 }
    const conditionScore: Record<string, number> = {
      missing_all_both: 85, denture_problems: 80, failing_teeth: 75, missing_multiple: 60, other: 40,
    }

    const uScore = urgencyScore[parsed.data.urgency] || 50
    const cScore = conditionScore[parsed.data.dental_condition] || 50
    const provisionalScore = Math.round((uScore * 0.5 + cScore * 0.5))
    const provisionalQualification =
      provisionalScore >= 75 ? 'hot' :
      provisionalScore >= 50 ? 'warm' :
      provisionalScore >= 25 ? 'cold' : 'unqualified'

    return NextResponse.json({
      success: true,
      lead_id: leadId,
      action: result?.action || 'created',
      score: {
        total: provisionalScore,
        qualification: provisionalQualification,
        summary: `Provisional score ${provisionalScore}/100. Full AI scoring and credit pre-qualification running in background.`,
        recommended_action: provisionalQualification === 'hot'
          ? 'Schedule consultation ASAP'
          : 'Follow up within 24 hours',
        is_provisional: true,
      },
    }, { status: isNew ? 201 : 200 })
  } catch (err) {
    console.error('Qualify error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
