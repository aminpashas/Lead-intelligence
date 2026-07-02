/**
 * Shared types for the GoHighLevel (GHL / LeadConnector) inbound sync.
 *
 * The sync PULLS GHL opportunities into Lead Intelligence as leads on a
 * schedule. These types mirror the subset of the GHL v2 API
 * (services.leadconnectorhq.com, Version 2021-07-28) that we read — kept
 * deliberately permissive because GHL returns extra fields we ignore and
 * occasionally omits ones we treat as optional.
 */

/** A stage within a GHL opportunity pipeline. */
export type GhlPipelineStage = {
  id: string
  name: string
}

/** A GHL opportunity pipeline (the board whose stages we mirror into LI). */
export type GhlPipeline = {
  id: string
  name: string
  stages?: GhlPipelineStage[]
}

/** A GHL contact (the person behind an opportunity). */
export type GhlContact = {
  id?: string
  name?: string
  contactName?: string
  firstName?: string
  lastName?: string
  email?: string
  phone?: string
}

/**
 * A GHL opportunity. The search endpoint sometimes embeds `contact` inline and
 * sometimes only carries `contactId`; the `updated*`/`date*` fields vary by API
 * revision, so we read several defensively for the sync watermark.
 */
export type GhlOpportunity = {
  id: string
  name?: string
  pipelineId?: string
  pipelineStageId?: string
  contactId?: string
  contact?: GhlContact
  status?: string
  monetaryValue?: number
  source?: string
  updatedAt?: string
  dateUpdated?: string
  lastStatusChangeAt?: string
  createdAt?: string
  dateAdded?: string
}

/**
 * Per-org GHL connection, resolved from `connector_configs`
 * (connector_type='ghl'). `apiToken` is a location-scoped Private Integration
 * Token; `pipelineId` is optional (null = sync every pipeline in the location).
 */
export type GhlConfig = {
  apiToken: string
  locationId: string
  pipelineId: string | null
  baseUrl: string
  version: string
  /**
   * Who owns a synced lead's pipeline stage after import.
   *  - 'li'  (default): GHL sets the stage on FIRST import only; LI-side moves
   *    are authoritative and never overwritten by later syncs. Use this once
   *    you operate the pipeline in LI.
   *  - 'ghl': legacy behaviour — every sync mirrors GHL's stage onto the lead,
   *    overwriting any LI-side move.
   */
  stageAuthority: 'li' | 'ghl'
}

/** Outcome counts for one org's sync run — returned by the cron + manual trigger. */
export type GhlSyncResult = {
  status: 'ok' | 'skipped' | 'failed'
  pipelines: number
  fetched: number
  inserted: number
  deduplicated: number
  stageUpdated: number
  skipped: number
  noContact: number
  error?: string
}
