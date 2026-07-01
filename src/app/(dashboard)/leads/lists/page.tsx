import { redirect } from 'next/navigation'

// Smart Lists became "Audiences" under the Campaigns hub. Preserve old links.
export default function LegacySmartListsRoute() {
  redirect('/campaigns/audiences')
}
