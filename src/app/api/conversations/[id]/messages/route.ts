import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { auditPHIRead } from '@/lib/hipaa-audit'

// GET /api/conversations/[id]/messages - Get messages for a conversation
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Auth + org scoping
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, organization_id')
    .single()

  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify conversation belongs to user's org
  const { data: convo } = await supabase
    .from('conversations')
    .select('id, organization_id, lead_id')
    .eq('id', id)
    .eq('organization_id', profile.organization_id) // Defense-in-depth: explicit org scoping
    .single()

  if (!convo) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const { data: messages, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // HIPAA audit: log message content access (may contain PHI)
  if (messages && messages.length > 0) {
    auditPHIRead(
      { supabase, organizationId: convo.organization_id, actorId: profile.id },
      'conversation',
      id,
      `Accessed ${messages.length} messages (may contain PHI)`,
      ['diagnosis', 'phone', 'email'],
    )
  }

  // Mark conversation as read
  await supabase
    .from('conversations')
    .update({ unread_count: 0 })
    .eq('id', id)

  return NextResponse.json({ messages })
}
