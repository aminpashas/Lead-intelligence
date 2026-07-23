/**
 * URL (de)serialization for the advanced filter tree.
 *
 * The tree rides in a single URL-safe param (`af`) so a leads search stays
 * shareable/bookmarkable like the page's other filters. Isomorphic — used by
 * the server component (decode) and the client table (encode). Decoding is
 * validation-gated through filterNodeSchema, so a tampered or stale param fails
 * closed (null) instead of injecting an unknown field or throwing.
 */

import { filterNodeSchema, type FilterNode } from '@/lib/campaigns/filter-tree'

function toBase64Url(str: string): string {
  const b64 =
    typeof Buffer !== 'undefined'
      ? Buffer.from(str, 'utf8').toString('base64')
      : btoa(unescape(encodeURIComponent(str)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string | null {
  try {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
    return typeof Buffer !== 'undefined'
      ? Buffer.from(b64, 'base64').toString('utf8')
      : decodeURIComponent(escape(atob(b64)))
  } catch {
    return null
  }
}

/** Serialize a filter tree into a URL-safe param value. */
export function encodeFilterParam(node: FilterNode): string {
  return toBase64Url(JSON.stringify(node))
}

/** Parse a URL param back into a validated filter tree, or null if absent /
 *  malformed / referencing anything outside the field registry. */
export function decodeFilterParam(raw: string | undefined | null): FilterNode | null {
  if (!raw) return null
  const json = fromBase64Url(raw)
  if (json == null) return null
  try {
    const parsed = filterNodeSchema.safeParse(JSON.parse(json))
    return parsed.success ? (parsed.data as FilterNode) : null
  } catch {
    return null
  }
}
