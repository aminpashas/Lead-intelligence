/**
 * READ-ONLY probe: why do GHL's Instagram/Facebook threads not all appear in LI?
 *
 * Locates every social conversation in a recent GHL window, then checks each one
 * against LI: is there a lead for the contact, and did the thread land as a
 * conversation row? Prints per-thread status so a silent ingest drop is visible.
 * Redacts bodies; writes nothing.
 *
 *   npx tsx scripts/ghl-probe-social-gap.ts [maxPages]
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { getGhlConfig } from '../src/lib/ghl/client'
import { searchConversations, getConversationMessages, mapGhlChannel } from '../src/lib/ghl/conversations'

function req(n: string): string {
  const v = process.env[n]
  if (!v) {
    console.error(`Missing env: ${n}`)
    process.exit(1)
  }
  return v
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
  const orgId = conn.organization_id as string
  const config = await getGhlConfig(supabase, orgId)
  if (!config) {
    console.error('getGhlConfig null')
    process.exit(1)
  }

  // Collect social threads recent-first.
  const social: { id: string; contactId?: string; lastType?: string; lastDate?: string }[] = []
  let startAfterDate: string | undefined
  let scanned = 0
  for (let page = 0; page < maxPages; page++) {
    const { conversations, nextStartAfterDate } = await searchConversations(config, {
      startAfterDate,
      sort: 'desc',
      limit: 100,
    })
    if (conversations.length === 0) break
    for (const c of conversations) {
      scanned++
      const ch = mapGhlChannel(c.lastMessageType || c.type)
      if (ch === 'messenger' || ch === 'instagram') {
        social.push({
          id: c.id,
          contactId: c.contactId,
          lastType: c.lastMessageType,
          lastDate: c.lastMessageDate == null ? undefined : String(c.lastMessageDate),
        })
      }
    }
    if (!nextStartAfterDate) break
    startAfterDate = nextStartAfterDate
  }
  process.stderr.write(`scanned ${scanned} conversations, ${social.length} social\n`)

  console.log(`\n${'GHL convo'.padEnd(26)} ${'lastType'.padEnd(16)} ${'lead?'.padEnd(6)} ${'LI convo'.padEnd(10)} msgs  channels-in-thread`)
  console.log('─'.repeat(112))

  for (const s of social) {
    // Does LI have a lead mapped to this GHL contact?
    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .eq('organization_id', orgId)
      .eq('ghl_contact_id', s.contactId ?? '__none__')
      .maybeSingle()

    // Did any message from this GHL thread land? external_id is 'ghl_msg:<id>'.
    const { messages } = await getConversationMessages(config, s.id)
    const ids = messages.map((m) => `ghl_msg:${m.id}`)
    const { count: landed } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .in('external_id', ids.length ? ids : ['__none__'])

    // What channels does the thread actually contain (not just its last message)?
    const chans = new Set(messages.map((m) => mapGhlChannel(m.messageType) ?? '?'))

    const date = s.lastDate && /^\d+$/.test(s.lastDate) ? new Date(Number(s.lastDate)).toISOString().slice(0, 10) : ''
    console.log(
      `${s.id.slice(0, 24).padEnd(26)} ${(s.lastType ?? '').padEnd(16)} ${(lead ? 'yes' : 'NO').padEnd(6)} ` +
        `${`${landed ?? 0}/${messages.length}`.padEnd(10)} ${String(messages.length).padStart(4)}  ` +
        `${[...chans].join(',')}  ${date}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
