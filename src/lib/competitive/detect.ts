/**
 * Competitor mention detection (Phase 4). Pure name/alias matching over a lead's
 * message text, given the org's competitor list. Word-boundary, case-insensitive;
 * ignores very short aliases to avoid false positives. The inbound pipeline
 * persists matches to lead_competitor_mentions; the Closer uses them to tailor
 * a competitor-aware (compliant) rebuttal.
 */

export interface CompetitorRef {
  id: string
  name: string
  aliases?: string[] | null
}

export interface CompetitorMatch {
  competitorId: string
  name: string
  matchedTerm: string
}

const MIN_TERM_LEN = 3

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function detectCompetitorMentions(
  text: string,
  competitors: CompetitorRef[]
): CompetitorMatch[] {
  if (!text || !text.trim() || competitors.length === 0) return []
  const haystack = text.toLowerCase()
  const matches: CompetitorMatch[] = []
  const seen = new Set<string>()

  for (const c of competitors) {
    const terms = [c.name, ...(c.aliases ?? [])]
      .map((t) => (t ?? '').trim())
      .filter((t) => t.length >= MIN_TERM_LEN)

    for (const term of terms) {
      const re = new RegExp(`\\b${escapeRegExp(term.toLowerCase())}\\b`)
      if (re.test(haystack)) {
        if (seen.has(c.id)) break // one match per competitor is enough
        seen.add(c.id)
        matches.push({ competitorId: c.id, name: c.name, matchedTerm: term })
        break
      }
    }
  }

  return matches
}
