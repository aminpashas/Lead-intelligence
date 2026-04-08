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

  // Fetch org name for branding
  let orgName = ''
  try {
    const supabase = createServiceClient()
    const { data } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', orgId)
      .single()
    if (data) orgName = data.name
  } catch {
    // If we can't fetch org name, the form still works
  }

  const utmParams = {
    source_type: search.source || search.source_type || 'landing_page',
    utm_source: search.utm_source || '',
    utm_medium: search.utm_medium || '',
    utm_campaign: search.utm_campaign || '',
    utm_content: search.utm_content || '',
    utm_term: search.utm_term || '',
    gclid: search.gclid || '',
    fbclid: search.fbclid || '',
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-white to-blue-50">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center justify-center gap-2">
          <svg className="w-6 h-6 text-blue-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
          </svg>
          <h1 className="text-lg font-bold text-gray-900">
            {orgName || 'Smile Assessment'}
          </h1>
        </div>
      </header>

      {/* Trust bar */}
      <div className="bg-blue-600 text-white text-center py-2 text-sm font-medium">
        Free Assessment — No Obligation — Takes 2 Minutes
      </div>

      {/* Form */}
      <main className="py-4">
        <QualificationForm
          orgId={orgId}
          orgName={orgName}
          utmParams={utmParams}
        />
      </main>

      {/* Footer */}
      <footer className="border-t py-6 text-center text-xs text-gray-400">
        <p>Your information is private and protected.</p>
        <p className="mt-1">Powered by Lead Intelligence</p>
      </footer>
    </div>
  )
}
