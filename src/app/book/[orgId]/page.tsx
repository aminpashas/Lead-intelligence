import { BookingWidget } from '@/components/booking/booking-widget'

export default async function BookingPage({
  params,
}: {
  params: Promise<{ orgId: string }>
}) {
  const { orgId } = await params

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <div className="max-w-3xl mx-auto px-4 py-12">
        <BookingWidget orgId={orgId} />
      </div>
    </div>
  )
}
