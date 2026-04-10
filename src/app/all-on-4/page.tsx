import { Metadata } from 'next'
import { LandingPageContent } from '@/components/landing/all-on-4-landing'

export const metadata: Metadata = {
  title: 'All-on-4 Dental Implants | Dr. Amin Samadian | Same-Day New Teeth',
  description: 'Get permanent teeth in one day. 1,500+ full-arch cases by Dr. Amin Samadian. In-house lab, same-day 3D-printed teeth. Free consultation — see if you qualify.',
  openGraph: {
    title: 'All-on-4 Dental Implants — Same-Day Permanent Teeth',
    description: '1,500+ cases. In-house lab. Same-day results. See if you qualify for a FREE consultation with Dr. Amin Samadian.',
    type: 'website',
  },
}

export default async function AllOn4LandingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>
}) {
  const search = await searchParams

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

  return <LandingPageContent utmParams={utmParams} />
}
