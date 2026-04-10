import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { z } from 'zod'

const rateSchema = z.object({
  conversation_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  notes: z.string().max(1000).optional(),
  flagged: z.boolean().optional(),
})

// POST /api/ai/audit/rate — Rate an AI conversation
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const body = await request.json()
  const parsed = rateSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 })
  }

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id, role')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Fetch conversation to get lead_id
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id, lead_id, organization_id')
    .eq('id', parsed.data.conversation_id)
    .single()

  if (!conversation) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  // Upsert rating (one per conversation per user)
  const { data: rating, error } = await supabase
    .from('ai_conversation_ratings')
    .upsert(
      {
        organization_id: profile.organization_id,
        conversation_id: parsed.data.conversation_id,
        lead_id: conversation.lead_id,
        rated_by: profile.id,
        rating: parsed.data.rating,
        notes: parsed.data.notes || null,
        flagged: parsed.data.flagged || false,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'conversation_id,rated_by' }
    )
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: 'Failed to save rating' }, { status: 500 })
  }

  return NextResponse.json({ rating })
}
