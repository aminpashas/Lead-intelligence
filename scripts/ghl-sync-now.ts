/**
 * Run the production ghl-sync cron body on-demand (SF Dentistry).
 *
 * This drives the SAME guarded engine the nightly /api/cron/ghl-sync route uses
 * — reconcileGhlStages (with the demotesEngaged reality-guard + booking guard)
 * followed by promoteEngagedNewLeads — NOT the legacy raw reconcile script.
 * It therefore corrects genuine GHL advancements (won/lost/booked) without
 * demoting leads LI has already engaged. Idempotent.
 *
 * Usage:
 *   npx tsx scripts/ghl-sync-now.ts          # run the guarded reconcile + unstale
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getGhlConfig } from '../src/lib/ghl/client'
import { reconcileGhlStages } from '../src/lib/ghl/reconcile'
import { promoteEngagedNewLeads } from '../src/lib/pipeline/unstale-new-stage'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry

function req(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`Missing env: ${name}`); process.exit(1) }
  return v
}

async function main() {
  const supabase: SupabaseClient = createClient(
    req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )
  const config = await getGhlConfig(supabase, ORG_ID)
  if (!config) { console.error('getGhlConfig null'); process.exit(1) }
  if (config.stageAuthority !== 'ghl') {
    console.error(`stage_authority is '${config.stageAuthority}', not 'ghl' — cron would skip. Aborting.`)
    process.exit(1)
  }

  console.log('Running guarded reconcileGhlStages…')
  const r = await reconcileGhlStages(supabase, ORG_ID, config)
  console.log('reconcile report:', JSON.stringify(r, null, 2))

  console.log('Running promoteEngagedNewLeads…')
  const unstale = await promoteEngagedNewLeads(supabase, ORG_ID)
  console.log('unstale report:', JSON.stringify(unstale, null, 2))

  console.log('\nDone.')
}

main().catch((e) => { console.error(e); process.exit(1) })
