/**
 * Automation Command Center — pure row/cell derivation.
 *
 * The ownership matrix ("who owns what work, right now") is computed CLIENT-
 * side from the same `resolveAllocation` the runtime uses, so the page can
 * never disagree with what the webhook/cron would actually do. Everything in
 * this file is pure and unit-tested; no I/O.
 */

import {
  resolveAllocation,
  type AllocationContext,
  type AllocationKind,
  type AllocationOrgConfig,
} from '@/lib/automation/allocation'
import type { AutomationPolicy } from '@/types/database'

// ── Work kinds (matrix rows at org level) ────────────────────────────

export const WORK_KINDS: Array<{ kind: AllocationKind; label: string; description: string }> = [
  {
    kind: 'inbound_reply',
    label: 'Inbound replies',
    description: 'Answering a lead who texted/emailed back',
  },
  {
    kind: 'speed_to_lead',
    label: 'Speed-to-lead',
    description: 'First touch on a brand-new lead',
  },
  {
    kind: 'nurture_step',
    label: 'Nurture steps',
    description: 'Scheduled campaign/sequence touches',
  },
  {
    kind: 'stage_automation',
    label: 'Stage automations',
    description: 'Actions fired by pipeline stage moves',
  },
  {
    kind: 'recommendation',
    label: 'Recommendations',
    description: 'Acting on pipeline recommendations',
  },
]

// ── Owner cell (one matrix cell) ─────────────────────────────────────

/** Configured owner as shown in the matrix (superset of runtime owners). */
export type MatrixOwner = 'ai' | 'human' | 'hybrid' | 'hold'

export type OwnerCell = {
  /** The CONFIGURED owner (what the policy says). */
  owner: MatrixOwner
  /** Who would act RIGHT NOW (hybrid resolves through the schedule). */
  effectiveNow: 'ai' | 'human' | 'hold'
  /** Human-readable source of the decision. */
  source: string
  /** Policy row that decided, if any ('default AI' / org toggle → null). */
  policyId: string | null
  slaSeconds: number | null
  aiRole: 'setter' | 'closer' | null
}

const SCOPE_SOURCE_LABEL: Record<AutomationPolicy['scope'], string> = {
  org_default: 'Org policy',
  campaign: 'Campaign policy',
  stage: 'Stage policy',
  segment: 'Segment policy',
}

/**
 * Derive one matrix cell by running the REAL allocation resolver, then mapping
 * its reason back to a configured owner + source label. Pure.
 */
export function deriveOwnerCell(
  policies: AutomationPolicy[],
  orgConfig: AllocationOrgConfig,
  ctx: AllocationContext
): OwnerCell {
  const decision = resolveAllocation(policies, orgConfig, ctx)
  const policy = decision.policyId
    ? policies.find((p) => p.id === decision.policyId) ?? null
    : null

  // Configured owner: the policy's own owner column (plus 'hold' when
  // human_first), or the implied default when no policy matched.
  let owner: MatrixOwner
  let source: string
  if (policy) {
    owner = policy.human_first ? 'hold' : policy.owner
    source = SCOPE_SOURCE_LABEL[policy.scope]
  } else if (decision.reason === 'org_human_first_sla') {
    owner = 'hold'
    source = 'Org human-first window'
  } else {
    owner = 'ai'
    source = 'Default (AI)'
  }

  return {
    owner,
    effectiveNow: decision.owner,
    source,
    policyId: decision.policyId,
    slaSeconds: decision.slaSeconds,
    aiRole: decision.aiRole,
  }
}

// ── Voice campaigns (read-only v1) ───────────────────────────────────

export type VoiceOwnerInput = {
  agent_type: 'setter' | 'closer'
  live_transfer_enabled: boolean
  transfer_mode: string
}

/**
 * Voice campaigns keep their allocation in their own columns (agent_type +
 * live-transfer config), not automation_policies — derive a read-only owner.
 */
export function deriveVoiceOwner(vc: VoiceOwnerInput): {
  owner: 'ai' | 'hybrid'
  label: string
} {
  if (vc.live_transfer_enabled) {
    const mode =
      vc.transfer_mode === 'immediate'
        ? 'immediate transfer'
        : vc.transfer_mode === 'qualify_transfer'
          ? 'AI qualifies, then transfers'
          : 'AI greets, then transfers'
    return { owner: 'hybrid', label: `AI ${vc.agent_type} dials · ${mode} to human` }
  }
  return { owner: 'ai', label: `AI ${vc.agent_type} handles the full call` }
}

// ── Workflow registry (EXPECTED_CRONS + latest heartbeat) ────────────

/**
 * Human-readable schedules for the health-checked crons. Keyed on
 * EXPECTED_CRONS names (src/lib/cron/with-cron.ts); kept here (not next to
 * EXPECTED_CRONS) so this map is importable by client components without
 * dragging the service-client module into the bundle.
 */
export const CRON_SCHEDULES: Record<string, string> = {
  'reconcile-growth-studio-outbox': 'Every 10 min',
  'forward-desk-outbox': 'Every 10 min',
  'dion-inbox-reprocess': 'Every 10 min',
  'existing-patient-rematch': 'Hourly',
  'a2p-status': 'Every 6 hours',
  reengagement: 'Hourly',
  'carestack-sync': 'Daily 04:30 UTC',
  'ghl-sync': 'Every 15 min',
  'voice-reconcile': 'Every 15 min',
  'windsor-sync': 'Daily 05:00 UTC',
  'brex-sync': 'Daily 06:00 UTC',
  disqualify: 'Daily 08:00 UTC',
  'calibrate-scoring': 'Weekly Sun 02:00 UTC',
  'sla-takeover': 'Every minute',
  'pipeline-recommendations': 'Hourly at :40',
  'recommendation-outcomes': 'Daily 01:50 UTC',
  'batch-15m': 'Every 15 min (dispatcher)',
  'batch-10m': 'Every 10 min (dispatcher)',
}

export type CronRunSnapshot = {
  status: string
  ran_at: string
  error: string | null
  items_processed: number | null
}

export type RegistryRow = {
  cron: string
  schedule: string
  lastStatus: string | null
  lastRanAt: string | null
  lastError: string | null
  itemsProcessed: number | null
  /** 'ok' | 'stale' | 'failing' | 'never_ran' */
  health: 'ok' | 'stale' | 'failing' | 'never_ran'
}

/**
 * Merge the expected-cron map (name → max stale minutes) with the latest
 * heartbeat per cron into display rows. Mirrors getCronHealth()'s rules:
 * failed latest run → 'failing'; heartbeat older than the window → 'stale';
 * no rows yet → 'never_ran' (informational, not alarming).
 */
export function buildRegistryRows(
  expected: Record<string, number>,
  latestRuns: Record<string, CronRunSnapshot | undefined>,
  now: Date = new Date()
): RegistryRow[] {
  return Object.entries(expected).map(([cron, maxStaleMin]) => {
    const run = latestRuns[cron]
    let health: RegistryRow['health'] = 'ok'
    if (!run) {
      health = 'never_ran'
    } else if (run.status === 'failed') {
      health = 'failing'
    } else if ((now.getTime() - new Date(run.ran_at).getTime()) / 60000 > maxStaleMin) {
      health = 'stale'
    }
    return {
      cron,
      schedule: CRON_SCHEDULES[cron] ?? '—',
      lastStatus: run?.status ?? null,
      lastRanAt: run?.ran_at ?? null,
      lastError: run?.error ?? null,
      itemsProcessed: run?.items_processed ?? null,
      health,
    }
  })
}

// ── Scoreboard formatting ────────────────────────────────────────────

/** 95 → "1m 35s"; 45 → "45s"; 3700 → "1h 2m"; null → "—". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return '—'
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const rem = s % 60
    return rem ? `${m}m ${rem}s` : `${m}m`
  }
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return m ? `${h}h ${m}m` : `${h}h`
}

/** 0.8234 → "82%"; null → "—". */
export function formatPercent(rate: number | null | undefined): string {
  if (rate == null || Number.isNaN(rate)) return '—'
  return `${Math.round(rate * 100)}%`
}

/** 12345.6 → "$12.3k"; 950 → "$950"; null → "—". */
export function formatMoney(amount: number | null | undefined): string {
  if (amount == null || Number.isNaN(amount)) return '—'
  if (Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`
  if (Math.abs(amount) >= 1_000) return `$${(amount / 1_000).toFixed(1)}k`
  return `$${Math.round(amount)}`
}

/** m:ss countdown for the SLA banner. Clamps at 0:00. */
export function formatCountdown(msRemaining: number): string {
  const s = Math.max(0, Math.ceil(msRemaining / 1000))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}
