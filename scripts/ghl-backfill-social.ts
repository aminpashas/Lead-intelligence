/**
 * Rescue social DM threads that the main conversation backfill left stranded.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Both historical sweeps (`conversation_backfill` and
 * `conversation_backfill_recent`) completed with `done:true` BEFORE
 * `mapGhlChannel` learned about Messenger/Instagram. At the time those channels
 * mapped to `null`, so every social message was dropped and no lead was minted.
 * Because the sweeps are marked done they never revisit, and the live-tail
 * poller only moves *forward* from its watermark — so pre-feature social threads
 * are invisible in LI permanently. A live audit found four Instagram threads
 * (16 messages) with no lead and zero messages ingested.
 *
 * This sweep is narrow on purpose: it looks ONLY at conversations whose last
 * message type maps to a social channel, so it never touches the ~240k skipped
 * SMS/email backlog and cannot mass-mint leads from it.
 *
 * Idempotent — messages dedup on `external_id` ('ghl_msg:<id>'), so re-running
 * is safe and re-running after a partial run resumes naturally.
 *
 * ── Known limitation ────────────────────────────────────────────────────────
 * GHL's conversation search exposes only `lastMessageType` (the envelope `type`
 * is `TYPE_PHONE` for 100% of threads and carries no signal). A thread that
 * contains social messages but whose NEWEST message is an SMS is therefore not
 * detected here. Those threads already have a lead, so nothing is orphaned —
 * only their social messages stay missing. `--deep` fetches every thread to
 * catch that case, at the cost of one API call per conversation.
 *
 *   npx tsx scripts/ghl-backfill-social.ts                 # dry run (default)
 *   npx tsx scripts/ghl-backfill-social.ts --apply         # actually write
 *   npx tsx scripts/ghl-backfill-social.ts --apply --deep  # + inspect every thread
 *   npx tsx scripts/ghl-backfill-social.ts --apply --alert # fire staff alerts too
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { getGhlConfig } from '../src/lib/ghl/client'
import {
  searchConversations,
  normalizeGhlMessage,
  mapGhlChannel,
  type GhlConversation,
} from '../src/lib/ghl/conversations'
import { fetchThread, resolveContactLead } from '../src/lib/ghl/backfill-conversations'
import { persistGhlMessage } from '../src/lib/ghl/ingest-message'
import { createLeadFromSocialDm, isNewSocialLead, isSocialMessage } from '../src/lib/ghl/social-lead'

function req(n: string): string {
  const v = process.env[n]
  if (!v) {
    console.error(`Missing env: ${n}`)
    process.exit(1)
  }
  return v
}

const argv = process.argv.slice(2)
const has = (f: string) => argv.includes(f)
const num = (f: string, d: number) => {
  const i = argv.indexOf(f)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d
}

const APPLY = has('--apply')
const DEEP = has('--deep')
// Old threads must NOT blast "new lead!" alerts at staff — a Jun 26 DM is not
// news. Opt in explicitly if you actually want them.
const ALERT = has('--alert')
const MAX_PAGES = num('--max-pages', 600)

/** Social by the conversation envelope — cheap, but only sees the last message. */
function looksSocial(conv: GhlConversation): boolean {
  const ch = mapGhlChannel(conv.lastMessageType || conv.type)
  return ch === 'messenger' || ch === 'instagram'
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
  if (!conn) {
    console.error('No enabled ghl connector')
    process.exit(1)
  }
  const orgId = conn.organization_id as string
  const config = await getGhlConfig(supabase, orgId)
  if (!config) {
    console.error('getGhlConfig null (missing token/location?)')
    process.exit(1)
  }

  console.log(APPLY ? '⚠️  APPLY MODE — writing to the database' : 'DRY RUN — nothing will be written')
  console.log(`org=${orgId} location=${config.locationId} deep=${DEEP} alert=${ALERT}\n`)

  const contactCache = new Map<string, Awaited<ReturnType<typeof resolveContactLead>>>()
  const conversationCache = new Map<string, string>()

  let scanned = 0
  let socialThreads = 0
  let leadsCreated = 0
  let inserted = 0
  let calls = 0
  let skipped = 0
  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await searchConversations(config, { startAfterDate: cursor, limit: 100, sort: 'desc' })
    if (res.conversations.length === 0) break

    for (const conv of res.conversations) {
      scanned++
      try {
        // Cheap gate first; --deep falls back to reading the thread so mixed
        // threads (social messages, SMS most recent) are still caught.
        let thread = null as Awaited<ReturnType<typeof fetchThread>> | null
        let social = looksSocial(conv)
        if (!social && DEEP) {
          thread = await fetchThread(config, conv.id)
          social = thread.some((m) => {
            const n = normalizeGhlMessage(m)
            return n != null && isSocialMessage(n)
          })
        }
        if (!social) continue

        socialThreads++
        if (!thread) thread = await fetchThread(config, conv.id)

        let lead = await resolveContactLead(supabase, orgId, config, conv.contactId, contactCache)

        if (!lead) {
          const firstSocial = thread
            .map(normalizeGhlMessage)
            .find((n): n is NonNullable<typeof n> => n != null && isNewSocialLead(n))
          if (firstSocial) {
            if (!APPLY) {
              leadsCreated++
            } else {
              lead = await createLeadFromSocialDm(
                supabase,
                orgId,
                config,
                conv.contactId ?? null,
                firstSocial,
                { caller: 'ghl-backfill-social-rescue', suppressAlert: !ALERT },
              )
              if (lead) leadsCreated++
            }
          }
        }

        if (!lead) {
          // Dry run can't create the lead, so its messages can't be attributed
          // yet — count them so the projected total is still meaningful.
          if (!APPLY) {
            for (const raw of thread) {
              const n = normalizeGhlMessage(raw)
              if (!n) skipped++
              else if (n.isCall) calls++
              else inserted++
            }
          }
          continue
        }

        for (const raw of thread) {
          const n = normalizeGhlMessage(raw)
          if (!n) {
            skipped++
            continue
          }
          if (!APPLY) {
            if (n.isCall) calls++
            else inserted++
            continue
          }
          const r = await persistGhlMessage(supabase, {
            organizationId: orgId,
            lead,
            normalized: n,
            conversationCache,
          })
          if (r.status === 'inserted') inserted++
          else if (r.status === 'call_logged') calls++
          else skipped++
        }
      } catch (err) {
        skipped++
        console.error(`  skip ${conv.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    process.stderr.write(`\r  scanned ${scanned} · social ${socialThreads} · msgs ${inserted}   `)
    if (!res.nextStartAfterDate) break
    cursor = res.nextStartAfterDate
  }
  process.stderr.write('\n')

  console.log(`
${APPLY ? 'APPLIED' : 'DRY RUN'}
  conversations scanned : ${scanned}
  social threads        : ${socialThreads}
  leads created         : ${leadsCreated}
  messages ingested     : ${inserted}
  calls logged          : ${calls}
  skipped (dupe/unmapped): ${skipped}
`)
  if (!APPLY) console.log('Re-run with --apply to write.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
