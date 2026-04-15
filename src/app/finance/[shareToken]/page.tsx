import { createServiceClient } from '@/lib/supabase/server'
import { FinancingApplicationFormPublic } from '@/components/forms/financing-application-form'
import type { Metadata } from 'next'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Financing Application | Dion Health',
  description: 'Apply for dental financing. Quick and easy — see if you qualify in minutes.',
}

export default async function FinancingPublicPage({
  params,
}: {
  params: Promise<{ shareToken: string }>
}) {
  const { shareToken } = await params
  const supabase = createServiceClient()

  // Look up the application by share token
  const { data: application } = await supabase
    .from('financing_applications')
    .select('id, organization_id, lead_id, status, expires_at, requested_amount')
    .eq('share_token', shareToken)
    .single()

  if (!application) {
    return (
      <div style={{ minHeight: '100vh', background: '#faf8f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', padding: '40px 24px', maxWidth: '420px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>🔗</div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, color: '#1c1917', marginBottom: '8px' }}>Link Not Found</h1>
          <p style={{ fontSize: '16px', color: '#78716c', lineHeight: 1.5 }}>
            This financing link is invalid or has been removed. Please contact the office for a new link.
          </p>
        </div>
      </div>
    )
  }

  const isExpired = new Date(application.expires_at) < new Date()
  const isAlreadySubmitted = application.status !== 'pending'

  if (isExpired) {
    return (
      <div style={{ minHeight: '100vh', background: '#faf8f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', padding: '40px 24px', maxWidth: '420px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>⏰</div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, color: '#1c1917', marginBottom: '8px' }}>Link Expired</h1>
          <p style={{ fontSize: '16px', color: '#78716c', lineHeight: 1.5 }}>
            This financing link has expired (24-hour limit). Please contact the office for a new link.
          </p>
        </div>
      </div>
    )
  }

  if (isAlreadySubmitted) {
    return (
      <div style={{ minHeight: '100vh', background: '#faf8f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', padding: '40px 24px', maxWidth: '420px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, color: '#1c1917', marginBottom: '8px' }}>Already Submitted</h1>
          <p style={{ fontSize: '16px', color: '#78716c', lineHeight: 1.5 }}>
            A financing application has already been submitted with this link. We&apos;ll contact you with the results.
          </p>
        </div>
      </div>
    )
  }

  // Load lead basic info to pre-fill the form
  // HIPAA-3: Only select non-PII fields for prefill. Email and phone are
  // encrypted at rest (start with 'enc::') — DO NOT pass ciphertext to
  // the client. The patient will re-enter their contact info in the form.
  const { data: lead } = await supabase
    .from('leads')
    .select('first_name, last_name, city, state')
    .eq('id', application.lead_id)
    .single()

  // Load org name
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', application.organization_id)
    .single()

  return (
    <div style={{ minHeight: '100vh', background: '#faf8f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* Header */}
      <header style={{ background: '#fff', borderBottom: '2px solid #e5e0d8', padding: '16px 20px', textAlign: 'center' }}>
        <p style={{ fontSize: '11px', fontWeight: 700, color: '#d97706', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '4px' }}>
          {org?.name || 'FINANCING APPLICATION'}
        </p>
        <h1 style={{ fontSize: '21px', fontWeight: 800, color: '#1f1a15', margin: 0, lineHeight: 1.3 }}>
          Apply for Financing
        </h1>
        <p style={{ fontSize: '14px', color: '#78716c', marginTop: '4px' }}>
          Quick &amp; secure. Soft credit pull only — won&apos;t affect your score.
        </p>
      </header>

      {/* Form */}
      <main style={{ padding: '24px 16px 40px', maxWidth: '560px', margin: '0 auto' }}>
        <FinancingApplicationFormPublic
          applicationId={application.id}
          shareToken={shareToken}
          requestedAmount={application.requested_amount}
          prefill={{
            first_name: lead?.first_name || '',
            last_name: lead?.last_name || '',
            // HIPAA-3: email/phone excluded — they're encrypted in the DB
            // Patient will enter their own contact info in the form
            email: '',
            phone: '',
            city: lead?.city || '',
            state: lead?.state || '',
          }}
        />
      </main>

      {/* Footer */}
      <footer style={{ borderTop: '2px solid #e5e0d8', padding: '20px', textAlign: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '8px' }}>
          <span style={{ fontSize: '16px' }}>🔒</span>
          <p style={{ fontSize: '12px', color: '#a8a29e', margin: 0 }}>256-bit encryption. HIPAA compliant. Your data is protected.</p>
        </div>
        <p style={{ fontSize: '11px', color: '#d4d0c8' }}>{org?.name || 'Powered by Dion Health'}</p>
      </footer>
    </div>
  )
}
