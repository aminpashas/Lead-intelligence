/**
 * Read-only go/no-go check for the cold full-arch re-permission campaign.
 *
 * Reports, for one org: the consent_capture flag, the cold-segment lead counts +
 * how many are opt-in-eligible, the email-reachable share, voice config, and A2P
 * status. Touches nothing — purely diagnostic. Run before flipping any switch.
 *
 * Usage:
 *   LI_ORG_ID=… NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *   npx tsx scripts/consent-capture-readiness.ts
 *
 * Optional env: CONSENT_CAPTURE_TAG (default "full-arch-cold")
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

function reqEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`❌ Missing required env: ${name}`)
    process.exit(1)
  }
  return v
}

const ORG_ID = reqEnv('LI_ORG_ID')
const TAG = process.env.CONSENT_CAPTURE_TAG || 'full-arch-cold'
const supabase = createClient(reqEnv('NEXT_PUBLIC_SUPABASE_URL'), reqEnv('SUPABASE_SERVICE_ROLE_KEY'))

const mark = (ok: boolean) => (ok ? '✅' : '❌')

async function countLeads(build: (q: ReturnType<typeof baseQuery>) => ReturnType<typeof baseQuery>): Promise<number> {
  const { count } = await build(baseQuery())
  return count ?? 0
}
function baseQuery() {
  return supabase.from('leads').select('id', { count: 'exact', head: true }).eq('organization_id', ORG_ID)
}

async function main() {
  console.log(`\n🩺 Consent-capture readiness — org ${ORG_ID}  (tag "${TAG}")\n${'─'.repeat(60)}`)

  // Org config
  const { data: org } = await supabase
    .from('organizations')
    .select('name, feature_flags, voice_enabled, voice_retell_agent_id')
    .eq('id', ORG_ID)
    .maybeSingle()
  if (!org) {
    console.error('❌ Org not found — check LI_ORG_ID.')
    process.exit(1)
  }
  const flags = (org.feature_flags ?? {}) as Record<string, unknown>
  const consentCapture = flags.consent_capture === true
  const usSms = flags.us_sms_enabled === true

  // Lead segment
  const coldTotal = await countLeads((q) => q.contains('tags', [TAG]))
  const withEmail = await countLeads((q) => q.contains('tags', [TAG]).not('email', 'is', null))
  const eligible = await countLeads((q) =>
    q
      .contains('tags', [TAG])
      .not('email', 'is', null)
      .neq('email_opt_out', true)
      .neq('email_consent_status', 'declined')
      .or('sms_consent_status.eq.unknown,voice_consent_status.eq.unknown'),
  )
  const voiceConsented = await countLeads((q) => q.contains('tags', [TAG]).eq('voice_consent', true))

  // Opt-in funnel so far
  const { count: tokensPending } = await supabase
    .from('consent_capture_tokens')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', ORG_ID)
    .eq('status', 'pending')
  const { count: tokensConfirmed } = await supabase
    .from('consent_capture_tokens')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', ORG_ID)
    .eq('status', 'confirmed')

  // A2P status (best-effort; table may be empty pre-setup)
  let a2p = 'unknown'
  const { data: a2pRows } = await supabase.from('a2p_status').select('campaign_status').limit(1)
  if (a2pRows && a2pRows.length) a2p = (a2pRows[0] as { campaign_status: string | null }).campaign_status ?? 'unknown'

  console.log(`\nOrg: ${org.name ?? '(unnamed)'}`)
  console.log(`\nGATES`)
  console.log(`  ${mark(consentCapture)} consent_capture flag ${consentCapture ? 'ON' : 'OFF (cron will not run for this org)'}`)
  console.log(`  ${mark(process.env.CONSENT_CAPTURE_SEND === 'true')} CONSENT_CAPTURE_SEND (local env) ${process.env.CONSENT_CAPTURE_SEND === 'true' ? 'true' : 'not true → DRY RUN'}  ⚠️ verify in Vercel, not just here`)

  console.log(`\nSEGMENT (tag "${TAG}")`)
  console.log(`  cold leads loaded:          ${coldTotal}`)
  console.log(`  …with an email address:     ${withEmail}  ${coldTotal ? `(${Math.round((withEmail / coldTotal) * 100)}%)` : ''}`)
  console.log(`  ${mark(eligible > 0)} opt-in-eligible now:      ${eligible}`)
  if (coldTotal > 0 && withEmail === 0) {
    console.log(`     ⚠️ 0 emails on the cold pile → the email opt-in can't reach them. Voice-first/human-call path needed.`)
  }

  console.log(`\nOPT-IN FUNNEL`)
  console.log(`  tokens pending:             ${tokensPending ?? 0}`)
  console.log(`  tokens confirmed (opt-ins): ${tokensConfirmed ?? 0}`)
  console.log(`  leads with voice_consent:   ${voiceConsented}`)

  console.log(`\nVOICE / SMS`)
  console.log(`  ${mark(org.voice_enabled === true)} voice_enabled: ${org.voice_enabled === true}`)
  console.log(`  ${mark(!!org.voice_retell_agent_id)} voice_retell_agent_id: ${org.voice_retell_agent_id ? 'set' : 'missing'}`)
  console.log(`  ${mark(!!process.env.RETELL_API_KEY)} RETELL_API_KEY (local env): ${process.env.RETELL_API_KEY ? 'set' : 'missing'}  ⚠️ verify in Vercel`)
  console.log(`  ${mark(usSms)} us_sms_enabled flag: ${usSms} ${usSms ? '' : '(SMS blocked until 10DLC VERIFIED)'}  · A2P campaign status: ${a2p}`)

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Reminder: counsel sign-off + DNC scrub + SPF/DKIM/DMARC are HARD pre-send gates`)
  console.log(`(docs/cold-reactivation-go-live-runbook.md). This check does NOT verify those.\n`)
}

main().catch((err) => {
  console.error('\n❌ Readiness check failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
