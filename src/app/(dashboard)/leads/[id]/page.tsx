import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { LeadDetail } from '@/components/crm/lead-detail'

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  // Fetch lead with relations
  const { data: lead } = await supabase
    .from('leads')
    .select(`
      *,
      pipeline_stage:pipeline_stages(*),
      source:lead_sources(*),
      assigned_user:user_profiles!leads_assigned_to_fkey(*)
    `)
    .eq('id', id)
    .single()

  if (!lead) notFound()

  // Fetch activities
  const { data: activities } = await supabase
    .from('lead_activities')
    .select('*')
    .eq('lead_id', id)
    .order('created_at', { ascending: false })
    .limit(50)

  // Fetch conversations
  const { data: conversations } = await supabase
    .from('conversations')
    .select('*')
    .eq('lead_id', id)
    .order('last_message_at', { ascending: false })

  // Fetch pipeline stages
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', lead.organization_id)
    .order('position')

  // Fetch team members for assignment
  const { data: teamMembers } = await supabase
    .from('user_profiles')
    .select('id, full_name, email, role')
    .eq('organization_id', lead.organization_id)
    .eq('is_active', true)

  return (
    <LeadDetail
      lead={lead}
      activities={activities || []}
      conversations={conversations || []}
      stages={stages || []}
      teamMembers={teamMembers || []}
    />
  )
}
