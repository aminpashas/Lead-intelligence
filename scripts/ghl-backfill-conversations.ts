/**
 * GHL conversation history backfill — manual runner.
 *
 * Drives the same resumable engine the cron uses (src/lib/ghl/backfill-
 * conversations.ts), but from the CLI so you can babysit the first runs against
 * the live location before turning the cron on. WRITES to conversations /
 * messages / lead_activities and updates lead consent + aggregates.
 *
 * Usage:
 *   npx tsx scripts/ghl-backfill-conversations.ts --dry-run       # read-only: report, write NOTHING
 *   npx tsx scripts/ghl-backfill-conversations.ts                 # one chunk (150 convos)
 *   npx tsx scripts/ghl-backfill-conversations.ts --max-chunks 5  # up to 5 chunks
 *   npx tsx scripts/ghl-backfill-conversations.ts --chunk 25      # smaller chunks (safe first run)
 *   npx tsx scripts/ghl-backfill-conversations.ts --reset         # clear checkpoint, start over
 *   npx tsx scripts/ghl-backfill-conversations.ts --org <uuid>    # target a specific org
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { getGhlConfig } from '../src/lib/ghl/client'
import { backfillGhlConversations } from '../src/lib/ghl/backfill-conversations'

const DEFAULT_ORG = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry

function req(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`Missing env: ${name}`)
    process.exit(1)
  }
  return v
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const orgId = arg('--org') || DEFAULT_ORG
  const maxChunks = Number(arg('--max-chunks') || '1')
  const chunk = Number(arg('--chunk') || '150')
  const reset = process.argv.includes('--reset')
  const dryRun = process.argv.includes('--dry-run')

  const supabase = createClient(
    req('NEXT_PUBLIC_SUPABASE_URL'),
    req('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )

  const config = await getGhlConfig(supabase, orgId)
  if (!config) {
    console.error(`No enabled GHL connector for org ${orgId}`)
    process.exit(1)
  }

  if (reset && !dryRun) {
    const { data } = await supabase
      .from('connector_configs')
      .select('settings')
      .eq('organization_id', orgId)
      .eq('connector_type', 'ghl')
      .maybeSingle()
    const settings = (data?.settings || {}) as Record<string, unknown>
    delete settings.conversation_backfill
    await supabase
      .from('connector_configs')
      .update({ settings })
      .eq('organization_id', orgId)
      .eq('connector_type', 'ghl')
    console.log('Checkpoint reset.')
  }

  const log = (m: string) => console.log(`  ${m}`)
  let totalInserted = 0
  let totalCalls = 0
  let totalLeads = 0

  if (dryRun) console.log('DRY RUN — reading live GHL, writing nothing.')
  for (let i = 0; i < maxChunks; i++) {
    console.log(`\n▶ chunk ${i + 1}/${maxChunks}`)
    const r = await backfillGhlConversations(supabase, orgId, config, { maxConversations: chunk, log, dryRun })
    totalInserted += r.messagesInserted
    totalCalls += r.callsLogged
    totalLeads += r.leadsAffected
    if (!r.moreRemain) {
      console.log('\n✅ Backfill complete — no conversations remain.')
      break
    }
  }

  console.log(
    `\nRun totals — messages: ${totalInserted}, calls: ${totalCalls}, leads touched: ${totalLeads}`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
