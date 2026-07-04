/**
 * GHL stage ground-truth audit (READ-ONLY — writes nothing).
 *
 * Pulls the live opportunity-stage distribution from every configured GHL
 * pipeline for one org, so we can (a) see the true stage the CRM should show
 * and (b) design a correct GHL-stage -> LI-native-stage reconcile mapping
 * before mutating ~45k leads.
 *
 * Usage:
 *   npx tsx scripts/ghl-stage-audit.ts
 */
import { config as loadEnv } from 'dotenv'
loadEnv({ path: '.env.local' })

import { createClient } from '@supabase/supabase-js'
import { getGhlConfig, fetchPipelines, ghlFetch } from '../src/lib/ghl/client'
import type { GhlConfig, GhlOpportunity } from '../src/lib/ghl/types'

const PAGE_LIMIT = 100

/**
 * Cursor-paginated opportunity search. GHL v2 requires startAfter/startAfterId
 * (the `page` param the client currently uses is rejected with HTTP 400).
 */
async function* iterateOpportunities(config: GhlConfig, pipelineId: string): AsyncGenerator<GhlOpportunity> {
  let startAfter: string | undefined
  let startAfterId: string | undefined
  for (let guard = 0; guard < 2000; guard++) {
    const data = await ghlFetch<{ opportunities?: GhlOpportunity[]; meta?: Record<string, unknown> }>(
      config,
      '/opportunities/search',
      {
        location_id: config.locationId,
        pipeline_id: pipelineId,
        limit: PAGE_LIMIT,
        startAfter: startAfter ?? undefined,
        startAfterId: startAfterId ?? undefined,
      },
    )
    const opps = data.opportunities ?? []
    for (const o of opps) yield o
    if (opps.length < PAGE_LIMIT) return
    const meta = data.meta ?? {}
    startAfter = meta.startAfter != null ? String(meta.startAfter) : undefined
    startAfterId = meta.startAfterId != null ? String(meta.startAfterId) : undefined
    if (!startAfter || !startAfterId) return
  }
}

const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c' // SF Dentistry

function req(name: string): string {
  const v = process.env[name]
  if (!v) { console.error(`Missing env: ${name}`); process.exit(1) }
  return v
}

async function main() {
  const supabase = createClient(
    req('NEXT_PUBLIC_SUPABASE_URL'),
    req('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )

  const config = await getGhlConfig(supabase, ORG_ID)
  if (!config) {
    console.error('getGhlConfig returned null — connector missing/disabled or token/location absent.')
    process.exit(1)
  }

  const allPipelines = await fetchPipelines(config)
  console.log(`\n=== GHL location has ${allPipelines.length} pipeline(s) ===`)
  for (const p of allPipelines) {
    console.log(`  pipeline ${p.id}  "${p.name}"  (${(p.stages ?? []).length} stages)`)
  }

  // config.pipelineId may be a single id OR a comma-joined list of ids.
  const configuredIds = new Set(
    String(config.pipelineId ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  )
  console.log(`\nConfigured pipeline ids: ${[...configuredIds].join(', ') || '(none -> all)'}`)
  console.log('Auditing ALL pipelines to expose coverage gaps.\n')

  let grand = 0
  for (const pipeline of allPipelines) {
    const stageName = new Map<string, string>()
    for (const st of pipeline.stages ?? []) stageName.set(st.id, st.name)

    const counts = new Map<string, number>()
    let total = 0
    for await (const opp of iterateOpportunities(config, pipeline.id)) {
      const name = opp.pipelineStageId
        ? stageName.get(opp.pipelineStageId) ?? `(unknown:${opp.pipelineStageId})`
        : '(no stage)'
      counts.set(name, (counts.get(name) ?? 0) + 1)
      total += 1
    }

    grand += total
    const synced = configuredIds.size === 0 || configuredIds.has(pipeline.id)
    console.log(`----- "${pipeline.name}" (${pipeline.id}) — ${total} opps ${synced ? '[SYNCED]' : '[NOT SYNCED]'} -----`)
    for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(6)}  ${name}`)
    }
    console.log('')
  }

  console.log(`=== GRAND TOTAL opportunities across ALL ${allPipelines.length} pipelines: ${grand} ===`)
}

main().catch((e) => { console.error(e); process.exit(1) })
