import { redirect } from 'next/navigation'

// Broadcasts moved under the Campaigns hub. Preserve old links/bookmarks.
export default function LegacyBroadcastsIndex() {
  redirect('/campaigns/broadcasts/sms')
}
