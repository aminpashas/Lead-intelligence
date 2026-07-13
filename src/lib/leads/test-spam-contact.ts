/**
 * Test-record & solicitation-spam classification for lead ingestion.
 *
 * A different concern from junk-contact.ts (which catches caller-ID *noise* on
 * call-tracking sources). This classifier catches two things that arrive across
 * ANY source — web form, GHL, WhatConverts, the DGS bridge:
 *
 *   • test_record  — staff/QA submissions ("Test Test", "john / test",
 *                    "final test - please ignore"). ai_score 0, never real.
 *   • solicitation — inbound B2B cold-pitches (SEO/marketing/crypto vendors)
 *                    submitted through a public contact form. The Jul-2026
 *                    "Donald" spam ("Dion Growth Studio, your brand development
 *                    services … we can refresh your visual identity … open to a
 *                    quick chat?", website aaa.com) is the canonical example.
 *
 * ── HIGH-PRECISION by design. ───────────────────────────────────────────────
 * Same rule as junk-contact.ts: a false positive buries a REAL prospect, a false
 * negative just leaves one card to triage. So every pattern here was validated
 * against the full prod corpus (54,699 DGS inbound + 59,410 LI leads, 2026-07-13):
 *   • The solicitation set matched exactly 1 record (Donald) and ZERO patients —
 *     deliberately excludes channel tags ("seo lead", "seo-website") and dental
 *     phrases ("missing multiple teeth") that a naive "seo|web" rule false-hits.
 *   • The test-name set requires an UNAMBIGUOUS test token in first or last name,
 *     or an explicit test phrase. Ambiguous placeholders (a lone "Abc") are left
 *     as leads on purpose.
 * Widen/tighten the token & phrase lists here; callers just consume the category.
 * ───────────────────────────────────────────────────────────────────────────
 */

export type SpamCategory = 'test_record' | 'solicitation'

export type TestOrSpamInput = {
  first_name?: string | null
  last_name?: string | null
  /** Free-text carried by the source (bridge `notes`, form message). */
  notes?: string | null
}

/** Unambiguous test tokens — a name field equal to one of these is never a real
 *  person. Matched as the WHOLE (normalized) field so "Preston" ≠ "test". */
const STRONG_TEST_TOKEN =
  /^(tests?|testing|test\d+|test[-_ ]?user|asdf+|qwerty|zxcv+|dummy|demo|sample|placeholder|x{3,}|z{3,}|testtest)$/

/** Placeholder pairs — treated as test only when BOTH name tokens are throwaway
 *  ("abc xyz", "abc abc"), so a lone real-ish "Abc" is NOT swept. */
const PLACEHOLDER_TOKEN = /^(abc|abcd|xyz|foo|bar|baz|qux)$/

/** Explicit "this is a test / please ignore" phrasing in a name or the notes. */
const TEST_PHRASE =
  /(please ignore|ignore this (lead|one|message|entry)|this is (a |just a )?test|test lead|testing purposes|qa test|test appointment|test submission|test[- ]?patient\b|final test)/i

/**
 * Inbound B2B solicitation phrasing. VALIDATED precise set — every alternative
 * was checked to not match real patient messages. Do NOT add bare "seo"/"web"
 * here: those are channel tags on genuine leads.
 */
const SOLICITATION =
  /(we can (help|refresh|build|rank|grow|boost|design|offer)|open to a (quick )?(chat|call)|your (brand|visual identity|web ?presence|online presence|rankings?|website traffic)|development services|digital marketing (agency|services|company)|link ?building|guest post|backlinks?|we specialize in|(partnership|investment|collaboration) opportunit|\bcrypto\b|\bbitcoin\b|increase your (traffic|sales|revenue|leads|ranking))/i

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Classify a lead as test/QA junk or inbound solicitation spam, or null when it
 * looks like a genuine contact. `solicitation` takes precedence over
 * `test_record` when both somehow match (a pitch is the more specific finding).
 */
export function classifyTestOrSpamLead(input: TestOrSpamInput): SpamCategory | null {
  const first = norm(input.first_name)
  const last = norm(input.last_name)
  const notes = norm(input.notes)
  const full = [first, last].filter(Boolean).join(' ')

  // Solicitation is judged on the free-text message only (names on these are
  // spoofed/random and carry no signal).
  if (notes && SOLICITATION.test(notes)) return 'solicitation'

  // Test records: an unambiguous test token in either name field, a throwaway
  // placeholder PAIR, or an explicit test phrase in the name or notes.
  const firstTokens = first.split(' ').filter(Boolean)
  const lastTokens = last.split(' ').filter(Boolean)
  const nameTokens = [...firstTokens, ...lastTokens]

  if (nameTokens.some((t) => STRONG_TEST_TOKEN.test(t))) return 'test_record'
  if (
    firstTokens.length > 0 &&
    lastTokens.length > 0 &&
    firstTokens.every((t) => PLACEHOLDER_TOKEN.test(t)) &&
    lastTokens.every((t) => PLACEHOLDER_TOKEN.test(t))
  ) {
    return 'test_record'
  }
  if (TEST_PHRASE.test(full) || TEST_PHRASE.test(notes)) return 'test_record'

  return null
}

/** Human-readable disqualified_reason for a classified category. */
export function spamDisqualifiedReason(category: SpamCategory): string {
  return category === 'solicitation'
    ? 'Auto-filtered at ingest: inbound B2B solicitation / marketing spam (not a patient).'
    : 'Auto-filtered at ingest: test/QA record (non-patient junk).'
}
