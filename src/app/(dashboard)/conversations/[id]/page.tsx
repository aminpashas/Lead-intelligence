import { createClient } from '@/lib/supabase/server'
import { ConversationThread } from '@/components/crm/conversation-thread'
import { notFound } from 'next/navigation'

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

  // Mark as read
  await supabase
    .from('conversations')
    .update({ unread_count: 0 })
    .eq('id', id)

  return (
    <ConversationThread
      lead={conversation.lead as any}
      conversation={conversation}
      messages={messages || []}
    />
  )
}
