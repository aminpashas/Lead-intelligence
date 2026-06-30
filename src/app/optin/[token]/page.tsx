import { createServiceClient } from '@/lib/supabase/server'
import { isTokenUsable, optInReachPhrase, optInDisclosureSentence, type ConsentCaptureChannel } from '@/lib/consent/capture'
import { OptInConfirm } from '@/components/consent/opt-in-confirm'

export const dynamic = 'force-dynamic'

const shell = (children: React.ReactNode) => (
  <div
    style={{
      minHeight: '100vh',
      background: '#faf8f5',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}
  >
    <div
      style={{
        background: '#fff',
        border: '2px solid #e5e0d8',
        borderRadius: 14,
        padding: '32px 28px',
        maxWidth: 480,
        width: '100%',
        textAlign: 'center',
      }}
    >
      {children}
    </div>
  </div>
)

export default async function OptInPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: row } = await supabase
    .from('consent_capture_tokens')
    .select('status, expires_at, organization_id, channels')
    .eq('token', token)
    .maybeSingle()

  if (!row) {
    return shell(
      <>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: '#1f1a15' }}>Link not found</h1>
        <p style={{ fontSize: 14, color: '#78716c', marginTop: 8 }}>
          This confirmation link is invalid. Please ask us to send a new one.
        </p>
      </>
    )
  }

  let orgName = ''
  const { data: org } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', row.organization_id)
    .maybeSingle()
  orgName = org?.name ?? ''

  const usable = isTokenUsable({ status: row.status, expires_at: row.expires_at })
  if (!usable.usable) {
    return shell(
      <>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: '#1f1a15' }}>
          {usable.reason === 'already_used' ? 'Already confirmed' : 'Link expired'}
        </h1>
        <p style={{ fontSize: 14, color: '#78716c', marginTop: 8 }}>
          {usable.reason === 'already_used'
            ? 'You have already confirmed — you are all set.'
            : 'This confirmation link has expired. Please ask us to send a new one.'}
        </p>
      </>
    )
  }

  const channels = (row.channels ?? ['sms', 'email']) as ConsentCaptureChannel[]

  return shell(
    <>
      <h1 style={{ fontSize: 21, fontWeight: 800, color: '#1f1a15', marginBottom: 8 }}>
        Confirm how {orgName || 'we'} can reach you
      </h1>
      <p style={{ fontSize: 14, color: '#78716c', marginBottom: 24 }}>
        Tap below so our care team can {optInReachPhrase(channels)} you about appointments, financing
        options, and your questions.
      </p>
      <OptInConfirm token={token} orgName={orgName} channels={channels} />
      <p style={{ fontSize: 11, color: '#a8a29e', marginTop: 20 }}>
        {optInDisclosureSentence(channels, orgName)}
      </p>
    </>
  )
}
