/**
 * READ-ONLY probe: which conversation CHANNEL TYPES does this GHL location
 * actually carry, and at what volume?
 *
 * Answers "can we source TikTok/GMB/WhatsApp DMs via the GHL mirror?" with data
 * instead of docs. Reads ONLY /conversations/search (the envelope carries
 * `type` + `lastMessageType`), so it never fetches a message body — no PII, and
 * one API call per 100 conversations. Writes nothing.
 *
 *   npx tsx <this file> [maxPages]
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { getGhlConfig } from '../src/lib/ghl/client'
import {
  searchConversations,
  mapGhlChannel,
} from '../src/lib/ghl/conversations'

function req(n: string): string {
  const v = process.env[n]
  if (!v) {
    console.error(`Missing env: ${n}`)
    process.exit(1)
  }
  return v
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1)
}

function table(title: string, m: Map<string, number>, total: number) {
  console.log(`\n${title}`)
  console.log('─'.repeat(64))
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1])
  for (const [k, n] of rows) {
    const pct = ((n / total) * 100).toFixed(1).padStart(5)
    console.log(`  ${k.padEnd(34)} ${String(n).padStart(6)}  ${pct}%`)
  }
  if (rows.length === 0) console.log('  (none)')
}

async function main() {
  const maxPages = Number(process.argv[2] ?? 60)
  const supabase = createClient(req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'))
  const { data: conn } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .eq('connector_type', 'ghl')
    .eq('enabled', true)
    .limit(1)
    .maybeSingle()
  if (!conn) {
    console.error('No enabled ghl connector')
    process.exit(1)
  }
  const config = await getGhlConfig(supabase, conn.organization_id as string)
  if (!config) {
    console.error('getGhlConfig null (missing token/location?)')
    process.exit(1)
  }

  const rawType = new Map<string, number>()
  const rawLastMsgType = new Map<string, number>()
  const mapped = new Map<string, number>()
  const unmapped = new Map<string, number>()
  let total = 0
  let oldest = ''
  let newest = ''

  // Recent-first: the newest threads are where any newly-connected channel
  // (a freshly linked TikTok/WhatsApp/GMB integration) would first appear.
  let startAfterDate: string | undefined
  for (let page = 0; page < maxPages; page++) {
    const { conversations, nextStartAfterDate } = await searchConversations(config, {
      startAfterDate,
      sort: 'desc',
      limit: 100,
    })
    if (conversations.length === 0) break
    for (const c of conversations) {
      total++
      bump(rawType, c.type ?? '(null)')
      bump(rawLastMsgType, c.lastMessageType ?? '(null)')
      const ch = mapGhlChannel(c.lastMessageType || c.type)
      bump(mapped, ch ?? '(UNMAPPED → dropped)')
      if (ch === null) bump(unmapped, `${c.type ?? '?'} / ${c.lastMessageType ?? '?'}`)
      const d = c.lastMessageDate == null ? '' : String(c.lastMessageDate)
      if (d) {
        if (!newest || d > newest) newest = d
        if (!oldest || d < oldest) oldest = d
      }
    }
    process.stderr.write(`\r  scanned ${total} conversations…`)
    if (!nextStartAfterDate) break
    startAfterDate = nextStartAfterDate
  }
  process.stderr.write('\n')

  const asDate = (ms: string) => (ms && /^\d+$/.test(ms) ? new Date(Number(ms)).toISOString() : ms)
  console.log(`\nGHL location: ${config.locationId}`)
  console.log(`Scanned ${total} conversations (recent-first, up to ${maxPages} pages)`)
  console.log(`Window: ${asDate(oldest)}  →  ${asDate(newest)}`)

  table('RAW conversation.type', rawType, total)
  table('RAW conversation.lastMessageType', rawLastMsgType, total)
  table('MAPPED to LI channel (via mapGhlChannel)', mapped, total)
  if (unmapped.size) table('⚠️  UNMAPPED (silently dropped by ingest today)', unmapped, total)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
