import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { analyzeConversation } from '@/lib/ai/conversation-analyst'
import { analyzePatientPsychology, getPatientProfile } from '@/lib/ai/patient-psychology'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'

/**
 * POST /api/ai/analyze
 *
 * Triggers both AI agents on a conversation:
 * 1. Conversation Analyst — rates tone, engagement, sales quality
 * 2. Patient Psychology — updates the patient's psychological profile
 *
 * Body: { conversation_id: string, lead_id: string }
 */
export async function POST(request: NextRequest) {
  const rlError = applyRateLimit(request, RATE_LIMITS.ai)
  if (rlError) return rlError

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: profile } = await supabase
      .from('user_profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single()
    if (!profile) return NextResponse.json({ error: 'No profile' }, { status: 401 })

    const body = await request.json()
    const { conversation_id, lead_id } = body

    if (!conversation_id || !lead_id) {
      return NextResponse.json({ error: 'conversation_id and lead_id required' }, { status: 400 })
    }

    // Fetch lead
    const { data: lead } = await supabase
      .from('leads')
      .select('*')
      .eq('id', lead_id)
      .eq('organization_id', profile.organization_id)
      .single()

    if (!lead) return NextResponse.json({ error: 'Lead not found' }, { status: 404 })

    // Fetch conversation messages
    const { data: messages } = await supabase
      .from('messages')
      .select('direction, body, sender_type, created_at')
      .eq('conversation_id', conversation_id)
      .eq('organization_id', profile.organization_id)
      .order('created_at', { ascending: true })

    if (!messages || messages.length < 2) {
      return NextResponse.json({ error: 'Need at least 2 messages to analyze' }, { status: 400 })
    }

    // Run both agents in parallel — use allSettled so one failure doesn't kill both
    const existingProfile = await getPatientProfile(supabase, lead_id)

    const [conversationResult, psychologyResult] = await Promise.allSettled([
      analyzeConversation(supabase, {
        organization_id: profile.organization_id,
        lead_id,
        conversation_id,
        lead,
        messages,
      }),
      analyzePatientPsychology(supabase, {
        organization_id: profile.organization_id,
        lead_id,
        conversation_id,
        lead,
        messages,
        existingProfile,
      }),
    ])

    const conversationAnalysis = conversationResult.status === 'fulfilled' ? conversationResult.value : null
    const patientProfile = psychologyResult.status === 'fulfilled' ? psychologyResult.value : null

    // Report partial failures
    const errors: string[] = []
    if (conversationResult.status === 'rejected') {
      errors.push(`Conversation analysis failed: ${conversationResult.reason instanceof Error ? conversationResult.reason.message : 'Unknown error'}`)
    }
    if (psychologyResult.status === 'rejected') {
      errors.push(`Psychology analysis failed: ${psychologyResult.reason instanceof Error ? psychologyResult.reason.message : 'Unknown error'}`)
    }

    // If both failed, return error
    if (!conversationAnalysis && !patientProfile) {
      return NextResponse.json({ error: 'Both analyses failed', details: errors }, { status: 500 })
    }

    return NextResponse.json({
      conversation_analysis: conversationAnalysis,
      patient_profile: patientProfile,
      ...(errors.length > 0 ? { warnings: errors } : {}),
    })
  } catch (error) {
    console.error('AI analyze error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Analysis failed' },
      { status: 500 }
    )
  }
}
