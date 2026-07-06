/**
 * Resume + diagnose the stalled GHL conversation backfill (SF Dentistry).
 *
 * Runs the SAME engine the cron drives (backfillGhlConversations, full asc
 * pass), resuming from the checkpoint in connector_configs.settings, chunk by
 * chunk, printing progress + the cursor date each tick. If the engine throws,
 * the full error/stack is printed and the loop stops — that's the stall cause.
 * Idempotent (messages dedup on external_id, calls on ghl_message_id).
 *
 * Usage:
 *   npx tsx scripts/ghl-conversations-drain.ts            # drain until done / time budget
 *   npx tsx scripts/ghl-conversations-drain.ts --once     # single chunk (diagnostic)
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getGhlConfig } from '../src/lib/ghl/client'
import { backfillGhlConversations } from '../src/lib/ghl/backfill-conversations'

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry
const ONCE = process.argv.includes('--once')
const CHUNK = 150
// Stop launching new chunks after this long (resumable). Override via DRAIN_MINUTES.
const TIME_BUDGET_MS = Number(process.env.DRAIN_MINUTES ?? 25) * 60 * 1000

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

  const started = Date.now()
  let tick = 0
  let totalMsgs = 0
  let totalCalls = 0
  let totalConvos = 0

  for (;;) {
    tick += 1
    const t0 = Date.now()
    try {
      const r = await backfillGhlConversations(supabase, ORG_ID, config, {
        maxConversations: CHUNK,
        order: 'asc',
        log: (m) => process.stderr.write(`    [engine] ${m}\n`),
      })
      totalConvos += r.conversationsProcessed
      totalMsgs += r.messagesInserted
      totalCalls += r.callsLogged

      // Read back the fresh checkpoint so we can see the cursor advance.
      const { data } = await supabase
        .from('connector_configs')
        .select('settings')
        .eq('organization_id', ORG_ID).eq('connector_type', 'ghl').maybeSingle()
      const st = ((data?.settings as Record<string, unknown>)?.conversation_backfill ?? {}) as { cursor?: string; done?: boolean }
      const cursorDate = st.cursor ? new Date(Number(st.cursor)).toISOString() : '(none)'

      console.log(
        `tick ${tick}: +${r.conversationsProcessed} conv, +${r.messagesInserted} msg, +${r.callsLogged} calls, ` +
        `skipped ${r.skipped}, leads ${r.leadsAffected}, cursor→ ${cursorDate}, ` +
        `moreRemain=${r.moreRemain} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
      )

      if (!r.moreRemain || st.done) { console.log(`\n✅ BACKFILL COMPLETE. totals this run: ${totalConvos} conv, ${totalMsgs} msg, ${totalCalls} calls`); break }
      if (ONCE) { console.log('\n--once: stopping after one chunk (backfill still has more).'); break }
      if (Date.now() - started > TIME_BUDGET_MS) { console.log(`\n⏳ time budget hit (${tick} ticks). Resumable — re-run to continue. totals: ${totalConvos} conv, ${totalMsgs} msg.`); break }
    } catch (err) {
      console.error(`\n❌ STALL CAUSE — engine threw on tick ${tick}:`)
      console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
      console.error('\nThe checkpoint was NOT advanced (engine writes state only after a clean chunk), which is why the cron froze here every run.')
      process.exit(1)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
