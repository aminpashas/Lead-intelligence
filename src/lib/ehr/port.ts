/**
 * The EHR/PMS port — the vendor-neutral contract every EMR integration implements.
 *
 * Why this exists: there is no service that plugs us into "all EMRs" (see
 * docs/emr-integration-landscape.md). Every EMR past the first is either a direct
 * adapter or a single aggregator-backed adapter covering a cluster, so the thing
 * that actually matters is the *marginal cost of adding one*. This port is that
 * cost: a new EMR is a new directory + one line in registry.ts, and nothing in
 * the booking seam, the cron, or the rollup moves.
 *
 * Ownership note: ECOSYSTEM.md assigns multi-PMS connectivity to the shared
 * `@dion/pms-connectors` package (which does not exist yet). Lead Intelligence
 * owns the *consumer* side — booking, availability, lead-outcome attribution —
 * so the port lives here while each adapter stays self-contained enough to be
 * lifted into that package later. Adapters must depend only on these types, not
 * on LI's schema.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EhrSource } from '@/types/database'

/**
 * What an adapter can actually do. This is not decoration — aggregator products
 * in this space commonly sell read-only tiers (Sikka's standard packages are
 * read-only; writeback is a custom quote), so an adapter that can pull occupancy
 * but not create an appointment is a real, expected configuration. Callers MUST
 * check before invoking, and treat a missing capability as `skipped`, not failed.
 */
export type EhrCapability =
  | 'appointment.write'   // can create/cancel appointments in the PMS
  | 'busy.sync'           // can pull occupancy for the availability engine
  | 'patient.search'      // can resolve/create a patient record
  | 'outcomes.sync'       // can pull procedures/invoices/appointments for rollups

/**
 * Per-runner result. Matches the shape the cron already aggregates and the
 * existing CareStack runners already return, so nothing downstream changes.
 */
export type SyncRun = {
  resource: string
  fetched: number
  upserted: number
  events_emitted: number
  status: string
  error?: string
}

/**
 * Our vocabulary for procedure state, so the revenue rollup stops speaking
 * CareStack's integer enum. Adapters map their vendor's codes onto this.
 * 'other' is the safe default: it contributes no money and no conversion date.
 */
export type NormalizedProcedureStatus = 'proposed' | 'accepted' | 'completed' | 'rejected' | 'other'

/**
 * Our vocabulary for how a visit turned out.
 * 'ignored' means "do not count this row at all" (cancelled/rescheduled/operatory
 * holds) — distinct from 'cancelled', which is a real cancellation we may want to
 * reason about later.
 */
export type NormalizedApptOutcome = 'scheduled' | 'completed' | 'no_show' | 'cancelled' | 'ignored'

/** Everything an adapter call needs. `config` is the adapter's own opaque config. */
export type EhrCtx = {
  supabase: SupabaseClient
  organizationId: string
  config: unknown
  /**
   * ms-epoch budget ceiling. Runners MUST stop paginating once past it and
   * persist their cursor as partial. This matters more with several adapters,
   * not less — see the cron's RUN_BUDGET_MS comment.
   */
  deadlineAt?: number
}

export type CreateAppointmentInput = {
  appointment: {
    id: string
    organization_id: string
    lead_id: string
    scheduled_at: string
    duration_minutes?: number | null
  }
  lead: Record<string, unknown>
}

export interface EhrAdapter {
  readonly source: EhrSource
  readonly capabilities: ReadonlySet<EhrCapability>

  /**
   * Resolve this org's config. Returns null when unconfigured or disabled —
   * that is a `skipped`, not an error. Must not throw for a missing config.
   */
  getConfig(supabase: SupabaseClient, organizationId: string): Promise<unknown | null>

  // ── write side (requires 'appointment.write') ──
  createAppointment(ctx: EhrCtx, input: CreateAppointmentInput): Promise<{ externalId: string }>
  cancelAppointment(ctx: EhrCtx, externalId: string, reasonCode?: string): Promise<void>

  /**
   * All pull-side runners for this vendor, in the order they must run.
   * Ordering is vendor-specific (CareStack must refresh patients before
   * procedures so patient→lead links resolve), so the adapter owns it rather
   * than the cron. Implementations must be idempotent, cursor-driven, and
   * deadline-aware, and must return one SyncRun per resource rather than throw.
   */
  runSync(ctx: EhrCtx): Promise<SyncRun[]>

  // ── normalization (pure; used by the vendor-neutral rollup) ──
  normalizeProcedureStatus(statusId: unknown): NormalizedProcedureStatus
  normalizeAppointmentStatus(status: unknown): NormalizedApptOutcome
}

/**
 * Coerce a vendor's external id to text.
 *
 * External ids are text on our side because CareStack uses numeric ids while most
 * other EMRs use GUIDs. Several columns are still `integer`/`bigint` in the live
 * DB pending the widening migration, so this is deliberately applied at the
 * boundary: string values round-trip correctly through PostgREST into an integer
 * column today, and keep working unchanged once the columns are text.
 */
export function toExternalId(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
