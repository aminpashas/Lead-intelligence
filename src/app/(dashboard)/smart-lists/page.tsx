import { createClient } from '@/lib/supabase/server'
import { SmartListsPage } from '@/components/crm/smart-lists-page'

export default async function SmartListsRoutePage() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) return null

  // Fetch smart lists
  const { data: smartLists } = await supabase
    .from('smart_lists')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('is_pinned', { ascending: false })
    .order('name')

  // Fetch pipeline stages for the builder
  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('position')

  // Fetch tags for the builder
  const { data: tags } = await supabase
    .from('tags')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('name')

  return (
    <SmartListsPage
      smartLists={smartLists || []}
      stages={stages || []}
      tags={tags || []}
    />
  )
}
