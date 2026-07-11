/**
 * One-off: seed the three per-service-line brands for SF Dentistry into
 * organizations.settings.branding, so brand-aware voice/booking/reminders work
 * without hand-typing the exact names in Settings → Branding.
 *
 * Writes ONLY organizations.settings.branding (org config — unaffected by the
 * messaging hard-stop). Logistics (address/parking/BART) is intentionally left
 * blank for the practice to fill in the Settings panel.
 *
 * Idempotent: upsertBranding deep-merges, so re-running is safe and preserves
 * any logistics the practice has since entered.
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
