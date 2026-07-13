import { RescheduleWidget } from '@/components/booking/reschedule-widget'

export const metadata = {
  title: 'Reschedule Your Appointment',
}

// Public, unauthenticated landing page reached from reminder-email/SMS links.
// The token in the query string is the only credential; the widget resolves it
// against /api/appointments/reschedule.
export default async function ReschedulePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <div className="max-w-3xl mx-auto px-4 py-12">
        <RescheduleWidget token={token ?? ''} />
      </div>
    </div>
  )
}
