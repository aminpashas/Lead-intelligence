import { MassEmailComposer } from '@/components/crm/mass-email-composer'

export default async function MassEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ smart_list_id?: string }>
}) {
  const { smart_list_id } = await searchParams
  return <MassEmailComposer initialSmartListId={smart_list_id} />
}
