import { MassSMSComposer } from '@/components/crm/mass-sms-composer'

export default async function MassSMSPage({
  searchParams,
}: {
  searchParams: Promise<{ smart_list_id?: string }>
}) {
  const { smart_list_id } = await searchParams
  return <MassSMSComposer initialSmartListId={smart_list_id} />
}
