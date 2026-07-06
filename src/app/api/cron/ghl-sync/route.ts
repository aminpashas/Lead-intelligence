/**
 * GoHighLevel -> Lead Intelligence stage reconciliation — nightly.
 *
 * For every org with a GHL connector configured, enabled, AND set to GHL stage
 * authority (settings.stage_authority = 'ghl'), re-map every opportunity across
 * the location's pipelines and correct the matching LI lead's stage / DND. GHL
 * is the source of truth for pipeline position; the DGS bridge remains the
 * source of truth for lead CREATION (this pass never creates leads).
 *
 * Orgs on the default 'li' authority are skipped — once you operate the pipeline
 * inside LI, GHL must not stomp your moves.
 *
 * Vercel cron: daily. A full sweep is heavy (all pipelines, all opportunities),
 * so it runs once a day rather than every 15 minutes.
 */

import { withCron } from '@/lib/cron/with-cron'
import { getGhlConfig } from '@/lib/ghl/client'
import { reconcileGhlStages } from '@/lib/ghl/reconcile'
import type { ReconcileReport } from '@/lib/ghl/reconcile'
import { promoteEngagedNewLeads, type UnstaleReport } from '@/lib/pipeline/unstale-new-stage'

/** The reconcile sweep can take minutes; give the function room. */
export const maxDuration = 300

type OrgRunResult =
  | ({ organization_id: string; unstale?: UnstaleReport } & ReconcileReport)
  | { organization_id: string; status: 'skipped' | 'failed'; reason: string }

export const POST = withCron('ghl-sync', async ({ supabase }) => {
  const { data: orgs } = await supabase
    .from('connector_configs')
    .select('organization_id')
    .eq('connector_type', 'ghl')
    .eq('enabled', true)

  if (!orgs || orgs.length === 0) {
    return { status: 'skipped', items: 0, data: { message: 'No GHL integrations configured', orgs: 0 } }
  }

  const results: OrgRunResult[] = []

  for (const org of orgs as Array<{ organization_id: string }>) {
    const config = await getGhlConfig(supabase, org.organization_id)
    if (!config) {
      results.push({ organization_id: org.organization_id, status: 'failed', reason: 'config_invalid' })
      continue
    }
    // GHL authority only — leave LI-owned pipelines untouched.
    if (config.stageAuthority !== 'ghl') {
      results.push({ organization_id: org.organization_id, status: 'skipped', reason: 'authority_li' })
      continue
    }
    try {
      const r = await reconcileGhlStages(supabase, org.organization_id, config)
      // After GHL positions the funnel, promote any lead LI has engaged but that
      // is still parked in New Lead — the reconcile guard prevents demotion but
      // never advances these, and the send-paths don't move stage. LI-truth pass,
      // so it also unsticks LI-only (e.g. WhatConverts) leads GHL never sees.
      const unstale = await promoteEngagedNewLeads(supabase, org.organization_id)
      const stageChanges =
        r.stageChanges + unstale.toContacted + unstale.toConsultationScheduled + unstale.toConsultationCompleted
      results.push({ organization_id: org.organization_id, ...r, stageChanges, unstale })
    } catch (err) {
      results.push({
        organization_id: org.organization_id,
        status: 'failed',
        reason: err instanceof Error ? err.message : 'reconcile_failed',
      })
    }
  }

  const items = results.reduce((n, r) => n + ('stageChanges' in r ? r.stageChanges : 0), 0)
  return { items, data: { orgs: results.length, results } }
})

export const GET = POST
