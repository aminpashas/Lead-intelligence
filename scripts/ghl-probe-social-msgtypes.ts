/**
 * READ-ONLY probe: per-message types inside specific GHL threads, and whether
 * each message landed in LI. Explains partial ingest (e.g. "20/22 landed").
 * Redacts bodies; writes nothing.
 *
 *   npx tsx scripts/ghl-probe-social-msgtypes.ts <convoId> [convoId...]
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { getGhlConfig } from '../src/lib/ghl/client'
import { getConversationMessages, mapGhlChannel } from '../src/lib/ghl/conversations'

function req(n: string): string {
  const v = process.env[n]
  if (!v) {
    console.error(`Missing env: ${n}`)
    process.exit(1)
  }
  return v
}

async function main() {
  const ids = process.argv.slice(2)
  if (ids.length === 0) {
    console.error('usage: ghl-probe-social-msgtypes.ts <convoId> [...]')
    process.exit(1)
  }
  const supabase = createClient(req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'))
  const { data: conn } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .eq('connector_type', 'ghl')
    .eq('enabled', true)
    .limit(1)
    .maybeSingle()
  const config = await getGhlConfig(supabase, conn!.organization_id as string)
  if (!config) {
    console.error('getGhlConfig null')
    process.exit(1)
  }

  for (const convoId of ids) {
    const { messages } = await getConversationMessages(config, convoId)
    console.log(`\n=== ${convoId} — ${messages.length} messages ===`)
    console.log(`${'messageType'.padEnd(22)} ${'mapped'.padEnd(11)} ${'dir'.padEnd(9)} ${'landed'.padEnd(7)} bodyLen`)
    console.log('─'.repeat(70))
    for (const m of messages) {
      const ch = mapGhlChannel(m.messageType)
      const { count } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('external_id', `ghl_msg:${m.id}`)
      const landedAsActivity =
        ch === 'call'
          ? (
              await supabase
                .from('lead_activities')
                .select('id', { count: 'exact', head: true })
                .eq('external_id', `ghl_msg:${m.id}`)
            ).count
          : null
      const landed = (count ?? 0) > 0 ? 'yes' : landedAsActivity ? 'activity' : 'NO'
      console.log(
        `${(m.messageType ?? '(none)').padEnd(22)} ${String(ch).padEnd(11)} ${(m.direction ?? '?').padEnd(9)} ` +
          `${landed.padEnd(7)} ${String(m.body?.length ?? 0)}`,
      )
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
