/**
 * Backfill stale GHL call states / durations on `lead_activities`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The GHL poller usually sees a call message at RING time — GHL reports
 * `status:"ringing"` with no duration, which normalizes to state 'unknown'.
 * Ingest dedups on `ghl_message_id` and (before this fix) never updated the row
 * again, so the ring-time snapshot was frozen forever: Heather's real 258-second
 * consult with a patient was stored as a call that never connected. Older rows
 * predate call enrichment entirely and carry no state/duration keys at all.
 *
 * This walks every provisional row, re-fetches the message from GHL by
 * `ghl_message_id`, and rewrites state/duration/recording when GHL now knows
 * more. Eligibility uses the SAME pure `shouldRefreshCallActivity` predicate as
 * the live ingest path, so the two can never disagree.
 *
 * IDEMPOTENT / RESUMABLE — re-running only touches rows that are still
 * provisional. Safe to run while the poller is live (both use the predicate, and
 * a terminal row is never downgraded).
 *
 *   npx tsx scripts/ghl-backfill-call-states.ts            # dry run
 *   npx tsx scripts/ghl-backfill-call-states.ts --apply
 *   npx tsx scripts/ghl-backfill-call-states.ts --apply --limit 200
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { getGhlConfig } from '../src/lib/ghl/client'
import { extractGhlCall, shouldRefreshCallActivity } from '../src/lib/ghl/conversations'

const APPLY = process.argv.includes('--apply')
/**
 * Re-render titles from already-corrected metadata. The state backfill repairs
 * metadata, but the activity feed renders `title` — so a corrected call would
 * still display as a bare "Outbound call (GoHighLevel)". Purely offline (no GHL
 * requests): recomputes the title from what is already stored.
 */
const FIX_TITLES = process.argv.includes('--fix-titles')
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit')
  return i >= 0 ? Number(process.argv[i + 1]) : Infinity
})()
const CONCURRENCY = 5
const PAGE = 1000

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Row = { id: string; metadata: Record<string, unknown> }

/**
 * Pre-filter: is this row worth spending a GHL request on?
 *
 * Deliberately NARROWER than shouldRefreshCallActivity's provisional test. That
 * predicate treats any null duration as provisional, which is right for deciding
 * whether a write is *allowed* — but a no_answer / busy / failed / voicemail call
 * legitimately has no duration forever, so using it to pick candidates re-fetches
 * ~1,900 settled rows on every run and never changes one (measured: 1,923
 * candidates → 3 updates). A row is worth re-fetching only when its outcome is
 * genuinely unknown, or it answered but somehow carries no duration.
 */
function isProvisional(meta: Record<string, unknown>): boolean {
  const s = typeof meta.call_state === 'string' ? meta.call_state : null
  const d = typeof meta.duration_seconds === 'number' ? meta.duration_seconds : null
  if (s === null || s === 'unknown') return true
  return s === 'answered' && d === null
}

/** Recompute an activity title from stored metadata — mirrors formatCallTitle. */
function titleFromMetadata(meta: Record<string, unknown>): string {
  const dir = meta.direction === 'outbound' ? 'Outbound' : 'Inbound'
  const LABEL: Record<string, string> = {
    answered: 'answered', voicemail: 'voicemail', no_answer: 'no answer', busy: 'busy', failed: 'failed',
  }
  const parts = [`${dir} call`]
  const label = typeof meta.call_state === 'string' ? LABEL[meta.call_state] : undefined
  if (label) parts.push(label)
  const dur = typeof meta.duration_seconds === 'number' ? meta.duration_seconds : 0
  if (dur > 0) parts.push(`${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}`)
  return `${parts.join(' · ')} (GoHighLevel)`
}

/** Offline pass: bring titles in line with metadata the state backfill corrected. */
async function fixTitles() {
  let scanned = 0, changed = 0
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('lead_activities')
      .select('id, title, metadata')
      .eq('activity_type', 'call_logged')
      // Explicit, stable sort: range() pagination over an unordered set shifts
      // under concurrent UPDATEs, silently skipping rows (it undercounted by ~40%
      // on the first run). Order by the primary key so paging is deterministic.
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    for (const r of data) {
      const meta = (r.metadata ?? {}) as Record<string, unknown>
      if (meta.source !== 'ghl') continue
      scanned++
      const next = titleFromMetadata(meta)
      if (next === r.title) continue
      changed++
      if (APPLY) await sb.from('lead_activities').update({ title: next }).eq('id', r.id as string)
    }
    if (data.length < PAGE) break
  }
  console.log(`titles scanned: ${scanned}`)
  console.log(`${APPLY ? 'retitled' : 'would retitle'}: ${changed}`)
}

async function main() {
  if (FIX_TITLES) {
    console.log(APPLY ? 'MODE: FIX TITLES (apply)\n' : 'MODE: FIX TITLES (dry run)\n')
    await fixTitles()
    return
  }

  const { data: conn } = await sb
    .from('connector_configs').select('organization_id')
    .eq('connector_type', 'ghl').eq('enabled', true).limit(1).maybeSingle()
  if (!conn) throw new Error('no enabled ghl connector')
  const cfg = await getGhlConfig(sb, conn.organization_id as string)
  if (!cfg) throw new Error('getGhlConfig null')
  const H = { Authorization: `Bearer ${cfg.apiToken}`, Version: cfg.version, Accept: 'application/json' }

  // ── collect provisional rows ───────────────────────────────────────────────
  const candidates: Row[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('lead_activities')
      .select('id, metadata')
      .eq('activity_type', 'call_logged')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    for (const r of data) {
      const meta = (r.metadata ?? {}) as Record<string, unknown>
      if (meta.source !== 'ghl' || !meta.ghl_message_id) continue
      if (isProvisional(meta)) candidates.push({ id: r.id as string, metadata: meta })
    }
    if (data.length < PAGE) break
  }
  const work = candidates.slice(0, LIMIT === Infinity ? undefined : LIMIT)
  console.log(`provisional rows: ${candidates.length}${work.length !== candidates.length ? ` (processing ${work.length})` : ''}`)
  console.log(APPLY ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n')

  let updated = 0, unchanged = 0, failed = 0
  const stateDelta: Record<string, number> = {}

  for (let i = 0; i < work.length; i += CONCURRENCY) {
    await Promise.all(work.slice(i, i + CONCURRENCY).map(async (row) => {
      const ghlId = String(row.metadata.ghl_message_id)
      try {
        const res = await fetch(`${cfg.baseUrl}/conversations/messages/${ghlId}`, { headers: H })
        if (!res.ok) { failed++; return }
        const j = await res.json()
        const msg = j.message ?? j
        const call = extractGhlCall(msg)
        if (!shouldRefreshCallActivity(row.metadata, { state: call.state, durationSec: call.durationSec })) {
          unchanged++
          return
        }
        const from = String(row.metadata.call_state ?? 'missing')
        stateDelta[`${from} → ${call.state}`] = (stateDelta[`${from} → ${call.state}`] ?? 0) + 1
        updated++
        if (APPLY) {
          await sb.from('lead_activities').update({
            metadata: {
              ...row.metadata,
              call_state: call.state,
              duration_seconds: call.durationSec,
              recording_url: call.recordingUrl,
              raw_call: call.raw,
              refreshed_at: new Date().toISOString(),
              refreshed_by: 'ghl-backfill-call-states',
            },
          }).eq('id', row.id)
        }
      } catch { failed++ }
    }))
    await sleep(600) // stay well inside GHL's ~100-per-10s burst allowance
    if ((i / CONCURRENCY) % 20 === 0) process.stdout.write(`\r  ${i + CONCURRENCY}/${work.length}…`)
  }

  console.log(`\n\n${APPLY ? 'updated' : 'would update'}: ${updated}`)
  console.log(`already accurate: ${unchanged}`)
  console.log(`fetch failures  : ${failed}`)
  console.log('\ntransitions:')
  for (const [k, v] of Object.entries(stateDelta).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)
}
main().then(() => process.exit(0)).catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
