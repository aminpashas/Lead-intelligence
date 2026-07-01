import { redirect } from 'next/navigation'

// The Broadcasts hub has no landing view of its own — send visitors to SMS.
export default function BroadcastsIndexPage() {
  redirect('/broadcasts/sms')
}
