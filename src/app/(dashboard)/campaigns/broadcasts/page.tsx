import { redirect } from 'next/navigation'

// The Broadcasts section has no landing view of its own — send visitors to SMS.
export default function BroadcastsIndexPage() {
  redirect('/campaigns/broadcasts/sms')
}
