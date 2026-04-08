import { QualificationForm } from '@/components/forms/qualification-form'
import { createServiceClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function QualifyPage({
  params, searchParams,
}: {
  params: Promise<{ orgId: string }>; searchParams: Promise<Record<string, string>>
}) {
  const { orgId } = await params
  const search = await searchParams

  let orgName = ''
  try {
    const supabase = createServiceClient()
    const { data } = await supabase.from('organizations').select('name').eq('id', orgId).single()
    if (data) orgName = data.name
  } catch {}

  const utmParams = {
    source_type: search.source || search.source_type || 'landing_page',
    utm_source: search.utm_source || '', utm_medium: search.utm_medium || '',
    utm_campaign: search.utm_campaign || '', utm_content: search.utm_content || '',
    utm_term: search.utm_term || '', gclid: search.gclid || '', fbclid: search.fbclid || '',
  }

  return (
    <div style={{ minHeight: '100vh', background: '#faf8f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* Top urgency bar */}
      <div style={{ background: '#dc2626', color: '#fff', textAlign: 'center', padding: '10px 16px', fontSize: '14px', fontWeight: 700, letterSpacing: '0.5px' }}>
        ⚡ FREE Consultations — Limited Spots This Month
      </div>

      {/* Header */}
      <header style={{ background: '#fff', borderBottom: '2px solid #e5e0d8', padding: '16px 20px', textAlign: 'center' }}>
        <p style={{ fontSize: '12px', fontWeight: 700, color: '#d97706', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>
          {orgName || 'Your Local Implant Center'}
        </p>
        <h1 style={{ fontSize: '22px', fontWeight: 800, color: '#1f1a15', margin: 0, lineHeight: 1.3 }}>
          See If You Qualify for Permanent Teeth
        </h1>
        <p style={{ fontSize: '15px', color: '#78716c', marginTop: '4px' }}>
          Takes 2 min. 100% free. No obligation.
        </p>
      </header>

      {/* Form */}
      <main style={{ paddingTop: '8px', paddingBottom: '24px' }}>
        <QualificationForm orgId={orgId} orgName={orgName} utmParams={utmParams} />
      </main>

      {/* Footer */}
      <footer style={{ borderTop: '2px solid #e5e0d8', padding: '20px', textAlign: 'center' }}>
        <p style={{ fontSize: '13px', color: '#a8a29e' }}>Your information is 100% private. We never sell or share your data.</p>
      </footer>
    </div>
  )
}
