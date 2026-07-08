import { CheckoutStatus } from '@/components/forms/checkout-status'
import type { Metadata } from 'next'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your Financing Plan | Dion Health',
  description: 'Track and complete your dental financing plan.',
}

export default async function CheckoutStatusPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  return (
    <div style={{ minHeight: '100vh', background: '#faf8f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <div style={{ maxWidth: '560px', margin: '0 auto', padding: '40px 20px' }}>
        <CheckoutStatus token={token} />
      </div>
    </div>
  )
}
