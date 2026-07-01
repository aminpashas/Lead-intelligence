/**
 * Pure helpers for the Smart List keyword filter. No I/O — unit-testable.
 */

/** Strip characters that break PostgREST or()/ilike filter strings; collapse to a clean term. */
export function sanitizeTerm(raw: string): string {
  return raw
    .replace(/[,%()*]/g, '') // PostgREST filter delimiters + wildcards + logic-tree parens
    .trim()
}

/** Combine per-term lead-id sets: 'any' = union, 'all' = intersection. */
export function combineTermMatches(sets: Set<string>[], match: 'any' | 'all'): Set<string> {
  if (sets.length === 0) return new Set()
  if (match === 'any') {
    const out = new Set<string>()
    for (const s of sets) for (const id of s) out.add(id)
    return out
  }
  const ordered = [...sets].sort((x, y) => x.size - y.size)
  let acc = new Set(ordered[0])
  for (let i = 1; i < ordered.length; i++) {
    const next = ordered[i]
    acc = new Set([...acc].filter((id) => next.has(id)))
    if (acc.size === 0) break
  }
  return acc
}
