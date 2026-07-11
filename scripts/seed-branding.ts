/**
 * One-off: seed the three per-service-line brands for SF Dentistry into
 * organizations.settings.branding, so brand-aware voice/booking/reminders work
 * without hand-typing the exact names in Settings → Branding.
 *
 * Writes ONLY organizations.settings.branding (org config — unaffected by the
 * messaging hard-stop). Seeds the shared logistics (address / by car / parking /
 * by BART / what-to-expect) for the 450 Sutter St office so booking
 * confirmations carry real directions. The practice can edit any of it in
 * Settings → Branding.
 *
 * Idempotent: upsertBranding deep-merges, so re-running is safe and preserves
 * any logistics the practice has since edited (patch only overwrites the keys
 * it sends).
 *
 * Usage: npx tsx scripts/seed-branding.ts
 * Env (from .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { upsertBranding } from '../src/lib/branding/store'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  if (!url || !key) throw new Error('Missing Supabase env')
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  const res = await upsertBranding(supabase, ORG_ID, {
    brands: {
      dion_health: {
        name: 'Dion Health',
        doctorName: 'Dr. Amin Samadian',
        website: 'dionhealth.com',
      },
      tmj_sleep: {
        name: 'San Francisco Center for TMJ and Sleep Apnea',
        doctorName: 'Dr. Amin Samadian',
        website: 'tmjandsleepapneasanfrancisco.com',
      },
      sf_dentistry: {
        name: 'SF Dentistry',
        doctorName: '', // general dentistry — no provider named
        website: 'sfdentistry.com',
      },
    },
    logistics: {
      addressText: '450 Sutter St, Suite 1519, San Francisco, CA 94108',
      drivingText:
        'We\'re in the 450 Sutter medical-dental building, on Sutter St between Powell and Stockton, just off Union Square. Check in at Suite 1519.',
      parkingText:
        'Nearest garage is the Sutter-Stockton Garage (444 Stockton St), about a block away — bring your ticket to the front desk for validation.',
      transitText:
        'Nearest BART/Muni is Powell St Station, roughly a 4-block walk up Powell to Sutter. The Powell-Mason & Powell-Hyde cable cars also stop a block away.',
      whatToExpectText:
        'Please arrive 10 minutes early to check in. Bring a photo ID and, if you have dental insurance, your insurance card. Your consultation lasts about 60 minutes — we\'ll review your goals, take any needed images, and walk you through your options and pricing. Nothing is decided on the spot; you\'ll leave with a clear plan.',
    },
  })

  if ('error' in res) {
    console.error('❌ seed-branding failed:', res.error)
    process.exit(1)
  }
  console.log('✅ seed-branding: brands written for SF Dentistry')
  console.log(JSON.stringify(res.branding.brands, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
