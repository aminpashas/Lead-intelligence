/**
 * READ-ONLY probe: what does a GHL call (TYPE_CALL) message actually contain?
 *
 * Tier-1 call enrichment (src/lib/ghl/conversations.ts → extractGhlCall) reads
 * duration / status / recording defensively from several candidate keys because
 * GHL's payload shape drifts by API revision. This script dumps the RAW shape of
 * real call messages so those keys can be confirmed and tightened.
 *
 * Prints structural keys + call-relevant fields only. Redacts message body text
 * and phone numbers (no PII/PHI in output). Writes nothing.
 *
 *   npx tsx scripts/ghl-probe-call-payload.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { getGhlConfig } from '../src/lib/ghl/client'
import { searchConversations, getConversationMessages, mapGhlChannel } from '../src/lib/ghl/conversations'

function req(n: string): string {
  const v = process.env[n]
  if (!v) { console.error(`Missing env: ${n}`); process.exit(1) }
  return v
}

/** Show a value's shape without leaking content. */
function shape(v: unknown): unknown {
  if (v == null) return v
  if (Array.isArray(v)) return `[array:${v.length}]`
  if (typeof v === 'object') return `{keys:${Object.keys(v as object).join(',')}}`
  if (typeof v === 'string') return v.length > 40 ? `<str:${v.length}>` : v
  return v
}

async function main() {
  const supabase = createClient(req('NEXT_PUBLIC_SUPABASE_URL'), req('SUPABASE_SERVICE_ROLE_KEY'))
  const { data: conn } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .eq('connector_type', 'ghl')
    .eq('enabled', true)
    .limit(1)
    .maybeSingle()
  if (!conn) { console.error('No enabled ghl connector'); process.exit(1) }
  const config = await getGhlConfig(supabase, conn.organization_id as string)
  if (!config) { console.error('getGhlConfig null (missing token/location?)'); process.exit(1) }

  const MAX_CALLS = 8
  let found = 0
  let startAfterDate: string | undefined
  console.log('Scanning conversations for TYPE_CALL messages…\n')

  for (let page = 0; page < 40 && found < MAX_CALLS; page++) {
    const { conversations, nextStartAfterDate } = await searchConversations(config, { startAfterDate })
    if (conversations.length === 0) break
    for (const convo of conversations) {
      if (found >= MAX_CALLS) break
      const { messages } = await getConversationMessages(config, convo.id)
      for (const m of messages) {
        if (mapGhlChannel(m.messageType) !== 'call') continue
        found++
        // Redact body + any phone-like fields; keep the structural + call keys.
        const { body: _b, ...rest } = m as Record<string, unknown>
        console.log(`--- call #${found} (messageType=${m.messageType}) ---`)
        console.log('top-level keys:', Object.keys(rest).join(', '))
        console.log('status      :', shape((m as Record<string, unknown>).status))
        console.log('meta        :', JSON.stringify((m as Record<string, unknown>).meta ?? null))
        console.log('attachments :', shape((m as Record<string, unknown>).attachments))
        console.log('dateAdded   :', (m as Record<string, unknown>).dateAdded)
        console.log('direction   :', (m as Record<string, unknown>).direction)
        console.log()
        if (found >= MAX_CALLS) break
      }
    }
    if (!nextStartAfterDate) break
    startAfterDate = nextStartAfterDate
  }

  console.log(found === 0
    ? 'No TYPE_CALL messages found in the scanned pages — GHL may not surface calls via the Conversations API for this location.'
    : `Done. Inspected ${found} call message(s). Use the meta/attachments/status keys above to tighten extractGhlCall().`)
}

main().catch((e) => { console.error(e); process.exit(1) })
