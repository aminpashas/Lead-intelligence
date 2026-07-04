import { createClient } from '@/lib/supabase/server'
import { ConversationThread } from '@/components/crm/conversation-thread'
import { notFound } from 'next/navigation'
import { decryptLeadPII } from '@/lib/encryption'

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const { data: conversation } = await supabase
    .from('conversations')
    .select('*, lead:leads(id, first_name, last_name, phone, email, ai_qualification, ai_score)')
    .eq('id', id)
    .single()

  if (!conversation) return notFound()

  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', id)
    .order('created_at', { ascending: true })

  // Completed calls for this conversation — rendered as transcript cards in the
  // timeline. Active calls (ended_at null) are handled live by the client panel,
  // so we only pull finished ones here to avoid double-rendering.
  const { data: calls } = await supabase
    .from('voice_calls')
    .select('*')
    .eq('conversation_id', id)
    .not('ended_at', 'is', null)
    .order('created_at', { ascending: true })

  // Mark as read
  await supabase
    .from('conversations')
    .update({ unread_count: 0 })
    .eq('id', id)

  return (
    <ConversationThread
      lead={decryptLeadPII(conversation.lead as Record<string, unknown>) as any}
      conversation={conversation}
      messages={messages || []}
      calls={calls || []}
    />
  )
}
