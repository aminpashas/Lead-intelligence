/**
 * Connector System — Public API
 *
 * Re-exports the dispatcher and helper functions for use throughout the CRM.
 *
 * Usage:
 *   import { dispatchConnectorEvent, buildConnectorLeadData } from '@/lib/connectors'
 */

export { dispatchConnectorEvent } from './dispatcher'
export { buildConnectorLeadData } from './helpers'
export { processReviewRequest, getGoogleReviewUrl } from './google-business/reviews'
export type {
  ConnectorEvent,
  ConnectorEventType,
  ConnectorResult,
  ConnectorType,
  ConnectorConfig,
  ConnectorLeadData,
} from './types'
export type { GoogleReviewConfig, ReviewRequestData } from './google-business/reviews'
