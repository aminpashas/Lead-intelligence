import { createClient } from '@/lib/supabase/server'
import { ConversationView } from '@/components/crm/conversation-view'
import { notFound } from 'next/navigation'
import { decryptLeadPII } from '@/lib/encryption'
import { buildTimeline } from '@/lib/timeline/build-timeline'
import { isFlagEnabled } from '@/lib/org/flags'

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

  // Notes + stage changes for this lead enrich the condensed Timeline view.
  const leadId = (conversation.lead as { id?: string } | null)?.id ?? conversation.lead_id
  const { data: activities } = await supabase
    .from('lead_activities')
    .select('id, created_at, activity_type, title, description')
    .eq('lead_id', leadId)
    .in('activity_type', ['note_added', 'stage_changed'])
    .order('created_at', { ascending: true })

  // Mark as read
  await supabase
    .from('conversations')
    .update({ unread_count: 0 })
    .eq('id', id)

  const timeline = buildTimeline({
    messages: messages || [],
    calls: calls || [],
    activities: activities || [],
  })

  // Account-level pre-qualification switch — gates the "Send Pre-Qual" action.
  const prequalEnabled = conversation.organization_id
    ? await isFlagEnabled(supabase, conversation.organization_id as string, 'financing_prequal_enabled')
    : false

  return (
    <ConversationView
      lead={decryptLeadPII(conversation.lead as Record<string, unknown>) as any}
      conversation={conversation}
      messages={messages || []}
      calls={calls || []}
      timeline={timeline}
      prequalEnabled={prequalEnabled}
    />
  )
}
