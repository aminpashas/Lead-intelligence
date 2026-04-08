import { QualificationForm } from '@/components/forms/qualification-form'
import { createServiceClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function QualifyPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>
  searchParams: Promise<Record<string, string>>
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
    <div className="min-h-screen" style={{ background: 'linear-gradient(180deg, #fefcf9 0%, #f5ede3 100%)' }}>
      {/* Header */}
      <header style={{ borderBottom: '2px solid #e8ddd0', background: 'rgba(254,252,249,0.95)', backdropFilter: 'blur(8px)' }} className="sticky top-0 z-10">
        <div className="max-w-xl mx-auto px-5 py-4 text-center">
          <h1 className="text-xl font-bold" style={{ color: '#3d3530' }}>
            {orgName || 'Your New Smile Starts Here'}
          </h1>
        </div>
      </header>

      {/* Trust banner */}
      <div className="text-center py-3 text-base font-semibold" style={{ background: '#c17f3e', color: 'white' }}>
        Free Assessment &bull; No Obligation &bull; Takes 2 Minutes
      </div>

      {/* Form */}
      <main className="py-4">
        <QualificationForm orgId={orgId} orgName={orgName} utmParams={utmParams} />
      </main>

      {/* Footer */}
      <footer className="py-8 text-center" style={{ borderTop: '2px solid #e8ddd0' }}>
        <p className="text-sm" style={{ color: '#8a7d72' }}>Your information is private and protected.</p>
        <p className="text-xs mt-2" style={{ color: '#b5a99a' }}>Powered by Lead Intelligence</p>
      </footer>
    </div>
  )
}
