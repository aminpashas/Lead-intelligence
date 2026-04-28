/**
 * Connector credentials encryption helpers.
 *
 * `connector_configs.credentials` is a JSONB blob holding API keys, OAuth
 * refresh tokens, webhook signing secrets, and similar per-org secrets.
 * We encrypt each string value at rest using the existing AES-256-GCM
 * primitive from `@/lib/encryption` (which already ships an `enc::` prefix
 * that makes decryption idempotent and allows plaintext passthrough during
 * a gradual rollout — existing rows keep working until next write).
 *
 * Shape contract: we only encrypt top-level string values. Numbers,
 * booleans, arrays, and nested objects are preserved as-is. In practice
 * every secret we store is a flat string, so this is sufficient and keeps
 * the on-disk JSON shape identical — just with `enc::...` substituted for
 * the raw value.
 */

import { encryptField, decryptField } from '@/lib/encryption'

type CredentialValue = unknown

/**
 * Credential keys that must stay plaintext because they're used in
 * Postgres JSONB WHERE clauses (e.g. looking up a CareStack org by the
 * `account_id` sent in a webhook header). These are public-ish identifiers
 * — vendor account IDs, not secrets.
 *
 * Only add to this list when a read path genuinely needs to query by value;
 * everything else should be encrypted by default.
 */
const NEVER_ENCRYPT_KEYS = new Set<string>([
  // CareStack webhook verification route filters on credentials->>account_id.
  'account_id',
])

/**
 * Encrypt string values in a credentials object before writing to the DB.
 * Non-string values pass through untouched.
 *
 * Idempotent: already-encrypted values (prefixed `enc::`) are preserved.
 */
export function encryptCredentials(
  credentials: Record<string, CredentialValue> | null | undefined
): Record<string, CredentialValue> {
  if (!credentials) return {}
  const out: Record<string, CredentialValue> = {}
  for (const [key, value] of Object.entries(credentials)) {
    if (typeof value === 'string' && value.length > 0 && !NEVER_ENCRYPT_KEYS.has(key)) {
      out[key] = encryptField(value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Decrypt string values in a credentials object after reading from the DB.
 * Plaintext values (no `enc::` prefix) pass through — this is intentional
 * so that rows written before encryption shipped still work. Any write path
 * through `/api/connectors` will upgrade them on next save.
 */
export function decryptCredentials<T extends Record<string, CredentialValue>>(
  credentials: T | null | undefined
): T {
  if (!credentials) return {} as T
  const out: Record<string, CredentialValue> = {}
  for (const [key, value] of Object.entries(credentials)) {
    if (typeof value === 'string' && value.length > 0) {
      try {
        out[key] = decryptField(value) ?? value
      } catch {
        // Corrupt / wrong-key value — preserve raw so callers can surface
        // a meaningful "reconnect required" error rather than crashing.
        out[key] = value
      }
    } else {
      out[key] = value
    }
  }
  return out as T
}
