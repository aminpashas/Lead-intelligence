/**
 * Live usage rollup — the data source for both cost panels.
 *
 * The cost_events ledger captures almost nothing today (SMS/voice capture lags real sends), so the
 * agency Spend & Margin panel and the per-account Usage page compute cost + billable *live* from
 * the source tables via the `usage_rollup` RPC (messages, voice_calls, ai_usage). This module
 * turns the RPC's raw quantities into dollars: it applies the rate card (pricing.ts) and the
 * re-bill markup (markup.ts), so pricing stays single-source in TypeScript and never drifts from
 * what the ledger writers would have produced.
 *
 * `loadLiveSpend` is dual-purpose:
 *   - organizationId omitted  → every practice (agency super-admin panel; RPC requires agency admin)
 *   - organizationId set      → that one practice (account page; RPC allows the org's own members)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  estimateSmsCents,
  estimateVoiceCents,
  estimateEmailCents,
} from './pricing'
import {
  computeBillable,
  resolvePlatformFeeCents,
  type BillableService,
  type MarkupConfig,
} from './markup'
import {
  summarizeSpendRows,
  type SpendRow,
  type SpendSummary,
} from './spend-summary'

/** Raw per-org usage counts returned by the usage_rollup RPC (all provider quantities). */
export type UsageQuantities = {
  smsOutCount: number
  smsOutSegments: number
  smsInCount: number
  emailOutCount: number
  voiceSeconds: number
  voiceCalls: number
  aiCalls: number
  aiTokensIn: number
  aiTokensOut: number
  /** AI provider cost is already computed at write time in ai_usage.cost_cents; summed here. */
  aiCostCents: number
}

/** Cost + billable for one service, plus the markup actually applied. */
export type ServiceLine = {
  service: BillableService
  costCents: number
  billableCents: number
  markupPct: number
}

export type OrgUsage = {
  organizationId: string
  quantities: UsageQuantities
  /** Per-service cost/billable/markup, keyed by service. */
  services: Record<BillableService, ServiceLine>
  costCents: number
  /** Usage re-bill (sum of per-service billable), before the flat platform fee. */
  billableCents: number
  /** Resolved MONTHLY platform fee for this practice (stored override or house default). */
  platformFeeMonthlyCents: number
  /** Platform fee pro-rated to the window (monthly × sinceDays/30), so blended math is comparable. */
  platformFeeCents: number
  /** What the practice is billed for the window: usage billable + pro-rated platform fee. */
  blendedCents: number
}

export type LiveSpend = {
  summary: SpendSummary
  /** Per-org detail (quantities + per-service dollars), for both the agency table and account page. */
  byOrg: Record<string, OrgUsage>
  orgNames: Record<string, string>
  /** Sum of resolved platform fees across the returned practices. */
  totalPlatformFeeCents: number
  /** Sum of blended bills (usage billable + platform fee) across practices. */
  totalBlendedCents: number
  /**
   * Enterprise (DSO) roll-up total: same value as totalBlendedCents but only set
   * when the call was filtered to one enterprise (opts.enterpriseAccountId), so
   * callers can label it unambiguously as "the whole enterprise's bill". NULL for
   * unfiltered / single-org / all-practices calls.
   */
  enterpriseTotalBlendedCents: number | null
  sinceDays: number
}

type RollupRow = {
  organization_id: string
  sms_out_count: number | string
  sms_out_segments: number | string
  sms_in_count: number | string
  email_out_count: number | string
  voice_seconds: number | string
  voice_calls: number | string
  ai_cost_cents: number | string
  ai_calls: number | string
  ai_tokens_in: number | string
  ai_tokens_out: number | string
}

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === 'string' ? Number(v) : v ?? 0
  return Number.isFinite(n) ? (n as number) : 0
}

function quantitiesOf(r: RollupRow): UsageQuantities {
  return {
    smsOutCount: num(r.sms_out_count),
    smsOutSegments: num(r.sms_out_segments),
    smsInCount: num(r.sms_in_count),
    emailOutCount: num(r.email_out_count),
    voiceSeconds: num(r.voice_seconds),
    voiceCalls: num(r.voice_calls),
    aiCalls: num(r.ai_calls),
    aiTokensIn: num(r.ai_tokens_in),
    aiTokensOut: num(r.ai_tokens_out),
    aiCostCents: num(r.ai_cost_cents),
  }
}

/**
 * Price a single org's quantities into per-service cost + billable using its markup config.
 * Provider cost: AI from ai_usage.cost_cents; SMS from (outbound segments + inbound) × rate;
 * voice from seconds × rate; email from send count × rate. Billable applies the re-bill markup.
 */
export function priceUsage(q: UsageQuantities, markup?: MarkupConfig): OrgUsage['services'] {
  const costs: Record<BillableService, number> = {
    ai: q.aiCostCents,
    // Twilio bills inbound segments too; treat each inbound message as ~1 segment.
    sms: estimateSmsCents(q.smsOutSegments + q.smsInCount),
    voice: estimateVoiceCents(q.voiceSeconds),
    email: estimateEmailCents(q.emailOutCount),
  }
  const services = {} as Record<BillableService, ServiceLine>
  for (const service of ['ai', 'sms', 'voice', 'email'] as BillableService[]) {
    const costCents = costs[service]
    const { billableCents, markupPct } = computeBillable(costCents, service, markup)
    services[service] = { service, costCents, billableCents, markupPct }
  }
  return services
}

export async function loadLiveSpend(
  supabase: SupabaseClient,
  opts: {
    sinceDays?: number
    /** Explicit period start; overrides sinceDays. Used for bounded (monthly) invoicing. */
    since?: Date | string
    /** Explicit period end (exclusive). Defaults to now when omitted. */
    until?: Date | string | null
    organizationId?: string | null
    /**
     * Roll spend up for a whole enterprise (DSO): the RPC returns per-location
     * rows for every org under this enterprise. Agency-admin only. Mutually
     * complementary with organizationId (omit it for the enterprise view).
     */
    enterpriseAccountId?: string | null
  } = {},
): Promise<LiveSpend> {
  const sinceDays = opts.sinceDays ?? 30
  const organizationId = opts.organizationId ?? null
  const enterpriseAccountId = opts.enterpriseAccountId ?? null

  const sinceIso = opts.since
    ? new Date(opts.since).toISOString()
    : new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
  const untilIso = opts.until ? new Date(opts.until).toISOString() : null

  // Days in the window drive platform-fee pro-ration (monthly fee × windowDays/30).
  const windowDays =
    opts.since && opts.until
      ? Math.max(1, (new Date(opts.until).getTime() - new Date(opts.since).getTime()) / 86_400_000)
      : sinceDays

  const { data, error } = await supabase.rpc('usage_rollup', {
    p_since: sinceIso,
    p_org: organizationId,
    p_until: untilIso,
    p_enterprise: enterpriseAccountId,
  })
  if (error) {
    // Surface an empty-but-valid shape; the pages render a "no usage" state rather than crash.
    return {
      summary: summarizeSpendRows([]),
      byOrg: {},
      orgNames: {},
      totalPlatformFeeCents: 0,
      totalBlendedCents: 0,
      enterpriseTotalBlendedCents: enterpriseAccountId ? 0 : null,
      sinceDays,
    }
  }

  const rows = (data ?? []) as RollupRow[]
  const orgIds = rows.map((r) => r.organization_id)

  // One billing_settings lookup for every org in the result (markups + platform fee).
  // Empty markups → platform default markup; absent fee → house default platform fee.
  const markupByOrg: Record<string, MarkupConfig> = {}
  const feeByOrg: Record<string, number | null> = {}
  if (orgIds.length > 0) {
    const { data: bs } = await supabase
      .from('billing_settings')
      .select('organization_id, markups, platform_fee_cents')
      .in('organization_id', orgIds)
    for (const b of bs ?? []) {
      markupByOrg[b.organization_id as string] = { markups: b.markups as Record<string, number> }
      feeByOrg[b.organization_id as string] = (b.platform_fee_cents as number | null) ?? null
    }
  }

  const spendRows: SpendRow[] = []
  const byOrg: Record<string, OrgUsage> = {}
  let totalPlatformFeeCents = 0
  let totalBlendedCents = 0

  for (const r of rows) {
    const oid = r.organization_id
    const markup = markupByOrg[oid] ?? null
    const quantities = quantitiesOf(r)
    const services = priceUsage(quantities, markup)

    let costCents = 0
    let billableCents = 0
    for (const service of ['ai', 'sms', 'voice', 'email'] as BillableService[]) {
      const line = services[service]
      costCents += line.costCents
      billableCents += line.billableCents
      spendRows.push({ organizationId: oid, service, costCents: line.costCents, billableCents: line.billableCents })
    }

    const platformFeeMonthlyCents = resolvePlatformFeeCents(feeByOrg[oid])
    const platformFeeCents = platformFeeMonthlyCents * (windowDays / 30) // pro-rate to the window
    const blendedCents = billableCents + platformFeeCents
    totalPlatformFeeCents += platformFeeCents
    totalBlendedCents += blendedCents

    byOrg[oid] = {
      organizationId: oid,
      quantities,
      services,
      costCents,
      billableCents,
      platformFeeMonthlyCents,
      platformFeeCents,
      blendedCents,
    }
  }

  const orgNames: Record<string, string> = {}
  if (orgIds.length > 0) {
    const { data: orgs } = await supabase.from('organizations').select('id, name').in('id', orgIds)
    for (const o of orgs ?? []) orgNames[o.id as string] = o.name as string
  }

  return {
    summary: summarizeSpendRows(spendRows),
    byOrg,
    orgNames,
    totalPlatformFeeCents,
    totalBlendedCents,
    // When filtered to one enterprise, the returned orgs ARE that enterprise's
    // locations, so the blended total is the enterprise roll-up.
    enterpriseTotalBlendedCents: enterpriseAccountId ? totalBlendedCents : null,
    sinceDays,
  }
}

/** Effective re-bill multiple of cost for a service (markup 300% → 4.0×). For display. */
export function costMultiple(markupPct: number): number {
  return 1 + markupPct / 100
}
