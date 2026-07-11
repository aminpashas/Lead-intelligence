import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { heartbeatPresence } from '@/lib/automation/presence'

// POST /api/conversations/[id]/presence — heartbeat: "I have this thread open".
// Called every ~30s by useConversationPresence while the tab is visible.
// Upserts the caller's own row in conversation_viewers (RLS enforces
// user_id = auth.uid(); we also verify org ownership of the conversation).
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await getOwnProfile(supabase, 'id, organization_id')
  if (!profile) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Verify conversation belongs to the caller's active org (defense-in-depth
  // on top of RLS, same as the messages route).
  const { data: convo } = await supabase
    .from('conversations')
    .select('id, organization_id')
    .eq('id', id)
    .eq('organization_id', orgId)
    .single()

  if (!convo) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const ok = await heartbeatPresence(supabase, {
    conversationId: id,
    userId: profile.id as string,
    organizationId: orgId,
  })

  return NextResponse.json({ ok })
}
