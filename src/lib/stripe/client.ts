/**
 * Stripe client + per-org config loader.
 *
 * Per-org config in connector_configs (connector_type='stripe'):
 *   credentials.secret_key       — sk_live_* or sk_test_*
 *   credentials.webhook_secret   — whsec_* (used to verify incoming webhook signatures)
 *   settings.financing_partner_metadata_key  — optional; defaults to 'financing_partner'
 *
 * Single-tenant deployments can ALSO supply STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
 * via env vars; we fall back to env when no per-org config is set.
 */

import Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'

export type StripeConfig = {
  secret_key: string
  webhook_secret: string
  financing_partner_metadata_key: string
}

/**
 * Load Stripe config for an org. Falls back to env vars when no per-org config exists.
 */
export async function getStripeConfig(
  supabase: SupabaseClient,
  organizationId: string
): Promise<StripeConfig | null> {
  const { data } = await supabase
    .from('connector_configs')
    .select('credentials, settings, enabled')
    .eq('organization_id', organizationId)
    .eq('connector_type', 'stripe')
    .maybeSingle()

  const creds = (data?.credentials || {}) as Partial<StripeConfig>
  const settings = (data?.settings || {}) as Partial<StripeConfig>

  const secretKey = creds.secret_key || process.env.STRIPE_SECRET_KEY
  const webhookSecret = creds.webhook_secret || process.env.STRIPE_WEBHOOK_SECRET

  if (!secretKey || !webhookSecret) return null
  if (data && data.enabled === false) return null

  return {
    secret_key: secretKey,
    webhook_secret: webhookSecret,
    financing_partner_metadata_key: settings.financing_partner_metadata_key || 'financing_partner',
  }
}

/**
 * Find the org that owns a given Stripe webhook signature.
 *
 * Stripe webhooks don't carry an org identifier; we identify the org by:
 *   1. Trying to verify the signature against each org's stored webhook_secret.
 *   2. First successful verification wins. (Ensures we ALWAYS know which org an event is for
 *      even with multi-tenant Stripe accounts.)
 *   3. If no per-org config matches, fall back to the env STRIPE_WEBHOOK_SECRET — that
 *      event is then attributed to the legacy single-tenant org (whatever STRIPE_DEFAULT_ORG_ID env is set to).
 *
 * Returns null if no secret matches (likely an attack or misconfiguration).
 */
export async function identifyOrgFromStripeSignature(
  supabase: SupabaseClient,
  rawBody: string,
  signature: string
): Promise<{ organizationId: string; event: Stripe.Event; config: StripeConfig } | null> {
  // Pull all org-level stripe configs.
  const { data: configs } = await supabase
    .from('connector_configs')
    .select('organization_id, credentials, settings')
    .eq('connector_type', 'stripe')
    .eq('enabled', true)

  type OrgRow = { organization_id: string; credentials: Record<string, string>; settings: Record<string, string> }
  const candidates: Array<{ orgId: string; secret_key: string; webhook_secret: string; financing_partner_metadata_key: string }> = []

  for (const row of (configs as OrgRow[] | null) || []) {
    const sec = row.credentials?.secret_key
    const whsec = row.credentials?.webhook_secret
    if (!sec || !whsec) continue
    candidates.push({
      orgId: row.organization_id,
      secret_key: sec,
      webhook_secret: whsec,
      financing_partner_metadata_key: row.settings?.financing_partner_metadata_key || 'financing_partner',
    })
  }

  // Env fallback for single-tenant deploys.
  const envSec = process.env.STRIPE_SECRET_KEY
  const envWhsec = process.env.STRIPE_WEBHOOK_SECRET
  const envOrgId = process.env.STRIPE_DEFAULT_ORG_ID
  if (envSec && envWhsec && envOrgId) {
    candidates.push({
      orgId: envOrgId,
      secret_key: envSec,
      webhook_secret: envWhsec,
      financing_partner_metadata_key: 'financing_partner',
    })
  }

  for (const cand of candidates) {
    try {
      const stripe = new Stripe(cand.secret_key)
      const event = stripe.webhooks.constructEvent(rawBody, signature, cand.webhook_secret)
      return {
        organizationId: cand.orgId,
        event,
        config: {
          secret_key: cand.secret_key,
          webhook_secret: cand.webhook_secret,
          financing_partner_metadata_key: cand.financing_partner_metadata_key,
        },
      }
    } catch {
      // Signature didn't match this org — try the next.
      continue
    }
  }

  return null
}

export function getStripeClient(config: StripeConfig): Stripe {
  return new Stripe(config.secret_key)
}
