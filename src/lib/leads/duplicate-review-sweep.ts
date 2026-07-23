/**
 * Duplicate-review sweep — surface likely-duplicate clusters as `human_tasks`.
 *
 * The lead-detail banner catches duplicates a staff member happens to open. This
 * sweep catches the ones nobody is looking at: it scans the whole org for leads
 * sharing an exact contact hash (via the `find_duplicate_clusters` RPC) and mints
 * ONE `duplicate_review` task per HIGH-confidence cluster, so the backlog of
 * legacy duplicates shows up in the queue staff already work.
 *
 * Grouping is done in SQL; the confidence POLICY is not — it is re-applied here
 * through the same `classifyConfidence` the banner uses, so the two surfaces can
 * never disagree about what counts as a duplicate. Only 'high' clusters become
 * tasks (an email/identity match, or a shared phone that ALSO shares a name);
 * a bare shared phone — households — is left to the interactive banner.
 *
 * Reconcile: a cluster that no longer has ≥2 live members (someone merged them)
 * has its task auto-closed, the same contract the follow-up sweep uses.
 *
 * Fails soft throughout: a sweep error must never take a cron batch down.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { leadDisplayName } from '@/lib/leads/display-name'
import {
  scoreDuplicatePair,
  type ScorableLead,
} from '@/lib/leads/duplicate-detection'
import { createHumanTask, resolveAssignee } from '@/lib/automation/tasks'

/** Most clusters to process in one run (backstop against a wide scan). */
const CLUSTER_CAP = 200

type ClusterRow = { key_type: string; key_hash: string; lead_ids: string[] }

type MemberRow = ScorableLead & { created_at: string }

const MEMBER_COLS =
  'id, first_name, last_name, email_hash, phone_hash, status, source_type, created_at'

/** Stable dedupe key: the cluster's members, sorted, so the same set collapses. */
export function duplicateReviewDedupeKey(leadIds: string[]): string {
  return `duplicate_review:${[...leadIds].sort().join(',')}`
}

/**
 * Does this cluster contain at least one HIGH-confidence pair? An email cluster
 * always does (shared email → high). A phone cluster qualifies only when two
 * members also share a name — a bare shared line is a household, not a dup.
 */
function highConfidenceMembers(members: MemberRow[]): MemberRow[] {
  const flagged = new Set<string>()
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const pair = scoreDuplicatePair(members[i], members[j])
      if (pair?.confidence === 'high') {
        flagged.add(members[i].id)
        flagged.add(members[j].id)
      }
    }
  }
  return members.filter((m) => flagged.has(m.id))
}

export type DuplicateSweepResult = { minted: number; closed: number; skipped: number }

/** Run the duplicate-review sweep for one org. */
export async function sweepDuplicateReviews(
  supabase: SupabaseClient,
  orgId: string,
): Promise<DuplicateSweepResult> {
  const result: DuplicateSweepResult = { minted: 0, closed: 0, skipped: 0 }

  const { data: clusters, error } = await supabase.rpc('find_duplicate_clusters', {
    p_org_id: orgId,
    p_limit: CLUSTER_CAP,
  })
  if (error) {
    logger.warn('DuplicateSweep: cluster rpc failed', { orgId, error: error.message })
    return result
  }

  // The live duplicate_review tasks this org already has, so we can dedupe on
  // mint and reconcile away tasks whose cluster has since been merged.
  const { data: existing } = await supabase
    .from('human_tasks')
    .select('id, dedupe_key')
    .eq('organization_id', orgId)
    .eq('kind', 'duplicate_review')
    .in('status', ['open', 'claimed'])
  const liveByKey = new Map<string, string>(
    ((existing ?? []) as { id: string; dedupe_key: string | null }[])
      .filter((t) => t.dedupe_key)
      .map((t) => [t.dedupe_key as string, t.id]),
  )
  const stillLiveKeys = new Set<string>()

  for (const cluster of (clusters ?? []) as ClusterRow[]) {
    const ids = cluster.lead_ids ?? []
    if (ids.length < 2) continue

    const { data: rows } = await supabase
      .from('leads')
      .select(MEMBER_COLS)
      .eq('organization_id', orgId)
      .in('id', ids)
    const members = (rows ?? []) as MemberRow[]
    if (members.length < 2) continue

    const flagged = highConfidenceMembers(members)
    if (flagged.length < 2) {
      result.skipped++
      continue
    }

    const dedupeKey = duplicateReviewDedupeKey(flagged.map((m) => m.id))
    stillLiveKeys.add(dedupeKey)
    if (liveByKey.has(dedupeKey)) continue // already queued

    // Anchor the task on the earliest-created member (a stable, sensible lead to
    // land on). The reviewer decides the true survivor.
    const anchor = [...flagged].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )[0]
    const names = flagged.map((m) =>
      leadDisplayName({ first_name: m.first_name, last_name: m.last_name, phone_formatted: null }),
    )

    const assignee = await resolveAssignee(supabase, orgId, anchor.id)
    const { taskId } = await createHumanTask(supabase, {
      organization_id: orgId,
      kind: 'duplicate_review',
      source: 'duplicate_sweep',
      title: `Review ${flagged.length} possible duplicates: ${names[0]}`,
      detail: `These leads look like the same person (${cluster.key_type} match): ${names.join(', ')}. Open the lead to merge.`,
      lead_id: anchor.id,
      assigned_to: assignee.userId,
      assigned_role: assignee.role,
      dedupe_key: dedupeKey,
      metadata: {
        cluster_key_type: cluster.key_type,
        lead_ids: flagged.map((m) => m.id),
        swept_at: new Date().toISOString(),
      },
    })
    if (taskId) result.minted++
  }

  // Reconcile: any live task whose cluster no longer flags (merged/resolved).
  const stale = [...liveByKey.entries()].filter(([key]) => !stillLiveKeys.has(key))
  if (stale.length > 0) {
    const now = new Date().toISOString()
    const { error: closeErr } = await supabase
      .from('human_tasks')
      .update({ status: 'done', completed_at: now, updated_at: now })
      .in('id', stale.map(([, id]) => id))
    if (closeErr) {
      logger.warn('DuplicateSweep: reconcile close failed', { orgId, error: closeErr.message })
    } else {
      result.closed += stale.length
    }
  }

  return result
}
