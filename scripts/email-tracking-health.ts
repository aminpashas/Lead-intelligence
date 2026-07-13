/**
 * Diagnostic: is email open/click tracking actually recording?
 * Run this after enabling Resend open-tracking + wiring the webhook to confirm
 * events are flowing. If `opened`/`clicked` stay at 0 while `delivered` climbs,
 * tracking is still dark (Resend tracking toggle off, or webhook not configured
 * / RESEND_WEBHOOK_SECRET mismatch → events 401'd). Zero bounces/complaints too
 * means the webhook is receiving NO events at all.
 *
 *   npx tsx scripts/email-tracking-health.ts            # last 30 days, all orgs
 *   npx tsx scripts/email-tracking-health.ts 90 <orgId> # custom window / org
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'

const days = Number(process.argv[2] || 30)
const orgId = process.argv[3] || null
const since = new Date(Date.now() - days * 86_400_000).toISOString()

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

async function count(filter: (q: any) => any): Promise<number> {
  let q = s.from('messages').select('id', { count: 'exact', head: true })
    .eq('channel', 'email').eq('direction', 'outbound').gte('created_at', since)
  if (orgId) q = q.eq('organization_id', orgId)
  const { count } = await filter(q)
  return count ?? 0
}

async function main() {
  const [total, delivered, opened, clicked, bounced, complained] = await Promise.all([
    count((q) => q),
    count((q) => q.in('status', ['delivered', 'read', 'sent'])),
    count((q) => q.not('opened_at', 'is', null)),
    count((q) => q.not('clicked_at', 'is', null)),
    count((q) => q.eq('status', 'bounced')),
    count((q) => q.eq('status', 'failed')),
  ])

  const pct = (n: number) => (total ? ((n / total) * 100).toFixed(1) + '%' : '—')
  console.log(`\n📧 Email tracking health — last ${days}d${orgId ? ` · org ${orgId}` : ' · all orgs'}`)
  console.log(`   sent/outbound : ${total}`)
  console.log(`   delivered-ish : ${delivered} (${pct(delivered)})`)
  console.log(`   opened        : ${opened} (${pct(opened)})`)
  console.log(`   clicked       : ${clicked} (${pct(clicked)})`)
  console.log(`   bounced       : ${bounced} (${pct(bounced)})`)
  console.log(`   complained    : ${complained} (${pct(complained)})`)
  console.log('')
  if (total > 0 && opened === 0 && clicked === 0) {
    console.log('🚨 TRACKING IS DARK — 0 opens & 0 clicks. Open/click events are not being')
    console.log('   recorded. Enable open+click tracking on the Resend domain and confirm the')
    console.log('   webhook endpoint /api/webhooks/resend + RESEND_WEBHOOK_SECRET in prod.')
  } else if (total > 0 && opened > 0) {
    console.log('✅ Open tracking is recording — the mass-send sunset filter is now active.')
  } else {
    console.log('ℹ️  No outbound email in this window.')
  }
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1) })
