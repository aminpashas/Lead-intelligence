import { createClient } from '@/lib/supabase/server'
import { SmartListsPage } from '@/components/crm/smart-lists-page'
import { resolveActiveOrg } from '@/lib/auth/active-org'

export default async function AudiencesPage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  const { data: smartLists } = await supabase
    .from('smart_lists')
    .select('*')
    .eq('organization_id', orgId)
    .order('is_pinned', { ascending: false })
    .order('name')

  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', orgId)
    .order('position')

  const { data: tags } = await supabase
    .from('tags')
    .select('*')
    .eq('organization_id', orgId)
    .order('name')

  return (
    <SmartListsPage
      smartLists={smartLists || []}
      stages={stages || []}
      tags={tags || []}
    />
  )
}
