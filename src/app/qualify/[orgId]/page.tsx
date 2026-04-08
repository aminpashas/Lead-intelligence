import { QualificationForm } from '@/components/forms/qualification-form'
import { QualificationFormSamadian } from '@/components/forms/qualification-form-samadian'
import { createServiceClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

// Map org IDs or slugs to custom form variants
const CUSTOM_FORMS: Record<string, 'samadian'> = {
  'fa64e53c-3d9b-493e-b904-59580cb3f29c': 'samadian', // Dion Health / Dr. Samadian
}

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
    const { data } = await supabase.from('organizations').select('name, slug').eq('id', orgId).single()
    if (data) orgName = data.name
  } catch {}

  const utmParams = {
    source_type: search.source || search.source_type || 'landing_page',
    utm_source: search.utm_source || '', utm_medium: search.utm_medium || '',
    utm_campaign: search.utm_campaign || '', utm_content: search.utm_content || '',
    utm_term: search.utm_term || '', gclid: search.gclid || '', fbclid: search.fbclid || '',
  }

  const variant = CUSTOM_FORMS[orgId]

  // Dr. Samadian custom page
  if (variant === 'samadian') {
    return (
      <div style={{ minHeight: '100vh', background: '#faf8f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
        <div style={{ background: '#dc2626', color: '#fff', textAlign: 'center', padding: '10px 16px', fontSize: '13px', fontWeight: 700, letterSpacing: '.5px' }}>
          ⚡ LIMITED: Free 3D CT Scan + Smile Design — Only 7 Spots Left
        </div>
        <header style={{ background: '#fff', borderBottom: '2px solid #e5e0d8', padding: '14px 20px', textAlign: 'center' }}>
          <p style={{ fontSize: '11px', fontWeight: 700, color: '#d97706', textTransform: 'uppercase', letterSpacing: '1.5px', marginBottom: '4px' }}>
            DR. AMIN SAMADIAN &bull; 1,500+ FULL ARCH CASES
          </p>
          <h1 style={{ fontSize: '21px', fontWeight: 800, color: '#1f1a15', margin: 0, lineHeight: 1.3 }}>
            See If You Qualify for Permanent Teeth
          </h1>
          <p style={{ fontSize: '14px', color: '#78716c', marginTop: '4px' }}>
            World-class results. In-house lab. Same-day 3D-printed teeth.
          </p>
        </header>
        <main style={{ paddingTop: '8px', paddingBottom: '24px' }}>
          <QualificationFormSamadian orgId={orgId} orgName={orgName} utmParams={utmParams} />
        </main>
        <footer style={{ borderTop: '2px solid #e5e0d8', padding: '20px', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', color: '#a8a29e' }}>Dr. Amin Samadian &bull; Board-Certified Cosmetic &amp; Implant Dentist &bull; TMJ &amp; Sleep Specialist</p>
          <p style={{ fontSize: '11px', color: '#d4d0c8', marginTop: '4px' }}>Your information is 100% private.</p>
        </footer>
      </div>
    )
  }

  // Generic page for all other practices
  return (
    <div style={{ minHeight: '100vh', background: '#faf8f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      <div style={{ background: '#dc2626', color: '#fff', textAlign: 'center', padding: '10px 16px', fontSize: '14px', fontWeight: 700, letterSpacing: '.5px' }}>
        ⚡ FREE Consultations — Limited Spots This Month
      </div>
      <header style={{ background: '#fff', borderBottom: '2px solid #e5e0d8', padding: '16px 20px', textAlign: 'center' }}>
        <p style={{ fontSize: '12px', fontWeight: 700, color: '#d97706', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>
          {orgName || 'Your Local Implant Center'}
        </p>
        <h1 style={{ fontSize: '22px', fontWeight: 800, color: '#1f1a15', margin: 0, lineHeight: 1.3 }}>
          See If You Qualify for Permanent Teeth
        </h1>
        <p style={{ fontSize: '15px', color: '#78716c', marginTop: '4px' }}>Takes 2 min. 100% free. No obligation.</p>
      </header>
      <main style={{ paddingTop: '8px', paddingBottom: '24px' }}>
        <QualificationForm orgId={orgId} orgName={orgName} utmParams={utmParams} />
      </main>
      <footer style={{ borderTop: '2px solid #e5e0d8', padding: '20px', textAlign: 'center' }}>
        <p style={{ fontSize: '13px', color: '#a8a29e' }}>Your information is 100% private. We never sell or share your data.</p>
      </footer>
    </div>
  )
}
