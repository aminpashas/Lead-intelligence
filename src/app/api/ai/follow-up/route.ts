import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateTailoredFollowUp, getPatientProfile } from '@/lib/ai/patient-psychology'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

/**
 * POST /api/ai/follow-up
 *
 * Generates a psychology-informed follow-up plan for a lead.
 * Uses the patient's accumulated profile to create deeply personalized outreach.
 *
 * Body: { lead_id: string, channel: 'sms' | 'email' | 'call', context?: string }
 */
export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.ai)
  if (rlError) return rlError

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single()
    if (!userProfile) return NextResponse.json({ error: 'No profile' }, { status: 401 })

    const body = await request.json()
    const { lead_id, channel = 'sms', context } = body

    if (!lead_id) {
      return NextResponse.json({ error: 'lead_id required' }, { status: 400 })
    }

    // Fetch lead
    const { data: lead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', lead_id)
      .eq('organization_id', userProfile.organization_id)
      .single()

    if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

    // Get patient psychology profile
    const profile = await getPatientProfile(supabase, lead_id)

    if (!profile) {
      return NextResponse.json({
        error: 'No patient profile yet. Run conversation analysis first (POST /api/ai/analyze).',
      }, { status: 400 })
    }

    // Fetch recent messages for context
    const { data: recentMessages } = await supabase
      .from('messages')
      .select('direction, body, sender_type, created_at')
      .eq('lead_id', lead_id)
      .eq('organization_id', userProfile.organization_id)
      .order('created_at', { ascending: false })
      .limit(10)

    // Generate tailored follow-up
    const followUpPlan = await generateTailoredFollowUp(supabase, {
      organization_id: userProfile.organization_id,
      lead_id,
      lead,
      profile: profile as unknown as Parameters<typeof generateTailoredFollowUp>[1]['profile'],
      recentMessages: (recentMessages || []).reverse(),
      channel,
      context,
    })

    return NextResponse.json({
      follow_up: followUpPlan,
      patient_profile_summary: {
        personality: profile.personality_type,
        trust_level: profile.trust_level,
        emotional_state: profile.emotional_state,
        anxiety_level: profile.anxiety_level,
        top_pain_points: (profile.pain_points as Array<{ point: string }>)?.slice(0, 3),
        unresolved_objections: (profile.objections as Array<{ objection: string; addressed: boolean }>)?.filter((o) => !o.addressed),
      },
    })
  } catch (error) {
    console.error('AI follow-up error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Follow-up generation failed' },
      { status: 500 }
    )
  }
}
