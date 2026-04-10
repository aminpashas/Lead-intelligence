import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/ai/audit — Fetch AI conversation audit data
export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id, role')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const url = new URL(request.url)
  const page = parseInt(url.searchParams.get('page') || '1')
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50)
  const agent = url.searchParams.get('agent') // setter | closer | all
  const rated = url.searchParams.get('rated') // true | false | all
  const flagged = url.searchParams.get('flagged') // true | false
  const offset = (page - 1) * limit

  // Fetch conversations that have AI-generated messages
  let query = supabase
    .from('conversations')
    .select(`
      id, lead_id, channel, status, active_agent, agent_handoff_count,
      message_count, last_message_at, sentiment, ai_enabled, ai_mode,
      created_at,
      lead:leads!inner(id, first_name, last_name, status, ai_score, ai_qualification)
    `, { count: 'exact' })
    .eq('organization_id', profile.organization_id)
    .eq('ai_enabled', true)
    .order('last_message_at', { ascending: false })

  if (agent && agent !== 'all') {
    query = query.eq('active_agent', agent)
  }

  const { data: conversations, count } = await query.range(offset, offset + limit - 1)

  if (!conversations) {
    return NextResponse.json({ conversations: [], total: 0, page, limit })
  }

  // Fetch AI message stats per conversation
  const convIds = conversations.map(c => c.id)

  const { data: messageStats } = await supabase
    .from('messages')
    .select('conversation_id, ai_generated, ai_confidence')
    .in('conversation_id', convIds)
    .eq('ai_generated', true)

  // Group message stats by conversation
  const statsMap: Record<string, { count: number; totalConfidence: number }> = {}
  for (const msg of messageStats || []) {
    if (!statsMap[msg.conversation_id]) {
      statsMap[msg.conversation_id] = { count: 0, totalConfidence: 0 }
    }
    statsMap[msg.conversation_id].count++
    statsMap[msg.conversation_id].totalConfidence += msg.ai_confidence || 0
  }

  // Fetch ratings for these conversations
  const { data: ratings } = await supabase
    .from('ai_conversation_ratings')
    .select('conversation_id, rating, notes, flagged, rated_by, created_at')
    .in('conversation_id', convIds)

  const ratingsMap: Record<string, { rating: number; notes: string | null; flagged: boolean }> = {}
  for (const r of ratings || []) {
    ratingsMap[r.conversation_id] = { rating: r.rating, notes: r.notes, flagged: r.flagged }
  }

  // Fetch latest conversation analyses
  const { data: analyses } = await supabase
    .from('conversation_analyses')
    .select('conversation_id, compliance_score, engagement_score, trust_score, coaching_notes')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: false })

  const analysisMap: Record<string, {
    compliance_score: number | null
    engagement_score: number | null
    trust_score: number | null
    coaching_notes: string | null
  }> = {}
  for (const a of analyses || []) {
    if (!analysisMap[a.conversation_id]) {
      analysisMap[a.conversation_id] = {
        compliance_score: a.compliance_score,
        engagement_score: a.engagement_score,
        trust_score: a.trust_score,
        coaching_notes: a.coaching_notes,
      }
    }
  }

  // Fetch handoff data
  const { data: handoffs } = await supabase
    .from('agent_handoffs')
    .select('conversation_id, from_agent, to_agent, trigger_reason, created_at')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: false })

  const handoffMap: Record<string, Array<{ from_agent: string; to_agent: string; trigger_reason: string; created_at: string }>> = {}
  for (const h of handoffs || []) {
    if (!handoffMap[h.conversation_id]) handoffMap[h.conversation_id] = []
    handoffMap[h.conversation_id].push(h)
  }

  // Assemble enriched conversation data
  let enriched = conversations.map(conv => {
    const stats = statsMap[conv.id]
    const rating = ratingsMap[conv.id]
    const analysis = analysisMap[conv.id]
    return {
      ...conv,
      ai_message_count: stats?.count || 0,
      avg_confidence: stats ? +(stats.totalConfidence / stats.count).toFixed(2) : null,
      rating: rating || null,
      analysis: analysis || null,
      handoffs: handoffMap[conv.id] || [],
    }
  })

  // Apply post-fetch filters
  if (rated === 'true') {
    enriched = enriched.filter(c => c.rating !== null)
  } else if (rated === 'false') {
    enriched = enriched.filter(c => c.rating === null)
  }

  if (flagged === 'true') {
    enriched = enriched.filter(c => c.rating?.flagged === true)
  }

  // Fetch aggregate stats
  const { count: totalAIConversations } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', profile.organization_id)
    .eq('ai_enabled', true)

  const { data: allRatings } = await supabase
    .from('ai_conversation_ratings')
    .select('rating, flagged')
    .eq('organization_id', profile.organization_id)

  const avgRating = allRatings && allRatings.length > 0
    ? +(allRatings.reduce((sum, r) => sum + r.rating, 0) / allRatings.length).toFixed(1)
    : null

  const flaggedCount = allRatings?.filter(r => r.flagged).length || 0

  const { count: setterCount } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', profile.organization_id)
    .eq('active_agent', 'setter')
    .eq('ai_enabled', true)

  const { count: closerCount } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', profile.organization_id)
    .eq('active_agent', 'closer')
    .eq('ai_enabled', true)

  return NextResponse.json({
    conversations: enriched,
    total: count || 0,
    page,
    limit,
    stats: {
      total_ai_conversations: totalAIConversations || 0,
      avg_rating: avgRating,
      total_rated: allRatings?.length || 0,
      flagged_count: flaggedCount,
      setter_conversations: setterCount || 0,
      closer_conversations: closerCount || 0,
    },
  })
}
