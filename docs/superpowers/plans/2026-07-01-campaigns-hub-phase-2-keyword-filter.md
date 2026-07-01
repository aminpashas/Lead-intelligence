# Campaigns Hub — Phase 2: Unified Keyword Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a unified keyword filter to Smart List (Audience) criteria that matches leads by terms across conversation content, lead text fields, inbound-SMS trigger words, and tag names.

**Architecture:** Additive `keywords` clause on `SmartListCriteria` (JSONB). Keyword matching resolves to a set of `lead_id`s per (term, scope) via PostgREST queries, combined in a pure, unit-tested helper (`any`=union, `all`=intersect across terms), then intersected with the rest of the criteria — the same pre-filter pattern the resolver already uses for tags. Encryption-aware: only plaintext columns and `messages.body` are searchable; encrypted PII (email/phone/DOB/insurance) is excluded.

**Tech Stack:** Next.js 16, TypeScript, Supabase JS (PostgREST), Postgres `pg_trgm`, vitest.

---

## Spec reference
Implements §6 (Audiences + keyword filter) and the Phase 2 rollout item of
`docs/superpowers/specs/2026-06-30-campaigns-hub-design.md`.

## Encryption constraint (critical)
`PII_FIELDS` (encrypted at rest, `src/lib/encryption.ts:129`): `email`, `phone`,
`phone_formatted`, `date_of_birth`, `insurance_provider`, `insurance_details`. These are
**not** substring-searchable (only exact HMAC `searchHash`). `messages.body` is **plaintext**
(`src/app/api/webhooks/email-reply/route.ts:125`). Therefore:
- `lead_fields` scope searches plaintext columns only: `first_name`, `last_name`, `city`,
  `ai_summary`, `dental_condition_details`, `current_dental_situation`. (NOT email/phone.)
- `conversation` scope: `messages.body` (all directions/channels).
- `inbound_sms` scope: `messages.body WHERE direction='inbound' AND channel='sms'`.
- `tags` scope: match `tags.name`, resolve to `lead_id` via `lead_tags`.

## File structure
- Modify: `src/types/database.ts` (SmartListCriteria) — Task 1
- Modify: `src/app/api/smart-lists/route.ts` + `src/app/api/smart-lists/[id]/route.ts` (Zod schema) — Task 1
- Create: `supabase/migrations/20260701_smart_list_keyword_indexes.sql` — Task 2
- Modify: `src/lib/campaigns/smart-list-resolver.ts` — Task 3
- Create: `src/lib/campaigns/keyword-match.ts` (pure combine helper) + `src/lib/__tests__/keyword-match.test.ts` — Task 3
- Modify: `src/app/api/smart-lists/[id]/leads/route.ts` — Task 4
- Modify: `src/components/crm/smart-list-builder.tsx` — Task 5

---

## Task 1: Add the `keywords` clause to the type and Zod schemas

**Files:** `src/types/database.ts`, `src/app/api/smart-lists/route.ts`, `src/app/api/smart-lists/[id]/route.ts`
**Test:** `src/lib/__tests__/smart-list-keyword-schema.test.ts`

- [ ] **Step 1: Write the failing schema test**

Create `src/lib/__tests__/smart-list-keyword-schema.test.ts`. Export the Zod schema from the
route first is not desirable; instead this test imports a shared schema. To keep it simple,
this task also extracts the criteria schema to a shared module. Create
`src/lib/validators/smart-list.ts`:

```ts
import { z } from 'zod'

export const KEYWORD_SCOPES = ['conversation', 'lead_fields', 'inbound_sms', 'tags'] as const

export const smartListCriteriaSchema = z.object({
  tags: z.object({
    ids: z.array(z.string().uuid()),
    operator: z.enum(['and', 'or']),
  }).optional(),
  statuses: z.array(z.string()).optional(),
  ai_qualifications: z.array(z.string()).optional(),
  score_min: z.number().min(0).max(100).optional(),
  score_max: z.number().min(0).max(100).optional(),
  stages: z.array(z.string().uuid()).optional(),
  source_types: z.array(z.string()).optional(),
  engagement_min: z.number().optional(),
  engagement_max: z.number().optional(),
  states: z.array(z.string()).optional(),
  created_after: z.string().optional(),
  created_before: z.string().optional(),
  has_phone: z.boolean().optional(),
  has_email: z.boolean().optional(),
  sms_consent: z.boolean().optional(),
  email_consent: z.boolean().optional(),
  keywords: z.object({
    terms: z.array(z.string().trim().min(1).max(80)).min(1).max(10),
    match: z.enum(['any', 'all']),
    scopes: z.array(z.enum(KEYWORD_SCOPES)).min(1),
  }).optional(),
})
```

Then the test:

```ts
import { describe, it, expect } from 'vitest'
import { smartListCriteriaSchema } from '@/lib/validators/smart-list'

describe('smartListCriteriaSchema keywords clause', () => {
  it('accepts a valid keywords clause', () => {
    const r = smartListCriteriaSchema.safeParse({
      keywords: { terms: ['financing'], match: 'any', scopes: ['conversation', 'lead_fields'] },
    })
    expect(r.success).toBe(true)
  })
  it('rejects empty terms', () => {
    expect(smartListCriteriaSchema.safeParse({ keywords: { terms: [], match: 'any', scopes: ['tags'] } }).success).toBe(false)
  })
  it('rejects an unknown scope', () => {
    expect(smartListCriteriaSchema.safeParse({ keywords: { terms: ['x'], match: 'any', scopes: ['bogus'] } }).success).toBe(false)
  })
  it('still accepts existing criteria without keywords', () => {
    expect(smartListCriteriaSchema.safeParse({ statuses: ['new'] }).success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run src/lib/__tests__/smart-list-keyword-schema.test.ts`
Expected: FAIL — module `@/lib/validators/smart-list` does not exist yet.

- [ ] **Step 3: Create the shared schema module** (the code block in Step 1) at `src/lib/validators/smart-list.ts`.

- [ ] **Step 4: Add `keywords` to the `SmartListCriteria` type**
In `src/types/database.ts`, inside `SmartListCriteria` (ends at the `}` after `email_consent`), add:
```ts
  keywords?: {
    terms: string[]
    match: 'any' | 'all'
    scopes: ('conversation' | 'lead_fields' | 'inbound_sms' | 'tags')[]
  }
```

- [ ] **Step 5: Point both routes at the shared schema**
In `src/app/api/smart-lists/route.ts`: delete the local `smartListCriteriaSchema` definition and
`import { smartListCriteriaSchema } from '@/lib/validators/smart-list'` instead (keep
`createSmartListSchema` referencing it). Do the same in `src/app/api/smart-lists/[id]/route.ts`
(inspect it first; if it defines its own criteria schema, replace with the shared import).

- [ ] **Step 6: Run tests + tsc**
Run: `npx vitest run src/lib/__tests__/smart-list-keyword-schema.test.ts` → PASS.
Run: `npx tsc --noEmit` → no new errors.

- [ ] **Step 7: Commit**
```bash
git add src/types/database.ts src/lib/validators/smart-list.ts src/app/api/smart-lists/route.ts "src/app/api/smart-lists/[id]/route.ts" src/lib/__tests__/smart-list-keyword-schema.test.ts
git commit -m "feat(audiences): add keywords clause to SmartListCriteria type + shared Zod schema"
```

---

## Task 2: Migration — pg_trgm + GIN indexes

**Files:** Create `supabase/migrations/20260701_smart_list_keyword_indexes.sql`

- [ ] **Step 1: Write the migration**
```sql
-- Keyword-filter support for Smart Lists (Audiences).
-- Trigram GIN indexes make ILIKE '%term%' substring search fast on the plaintext
-- columns the keyword filter targets. Encrypted PII columns are intentionally NOT indexed.
create extension if not exists pg_trgm;

-- Lead plaintext text columns
create index if not exists idx_leads_first_name_trgm on public.leads using gin (first_name gin_trgm_ops);
create index if not exists idx_leads_last_name_trgm on public.leads using gin (last_name gin_trgm_ops);
create index if not exists idx_leads_ai_summary_trgm on public.leads using gin (ai_summary gin_trgm_ops);
create index if not exists idx_leads_dental_condition_trgm on public.leads using gin (dental_condition_details gin_trgm_ops);
create index if not exists idx_leads_current_situation_trgm on public.leads using gin (current_dental_situation gin_trgm_ops);

-- Conversation content (all messages)
create index if not exists idx_messages_body_trgm on public.messages using gin (body gin_trgm_ops);

-- Inbound-SMS keyword lookups (partial index keeps it small)
create index if not exists idx_messages_inbound_sms_body_trgm on public.messages using gin (body gin_trgm_ops)
  where direction = 'inbound' and channel = 'sms';
```

- [ ] **Step 2: Sanity-check SQL**
Run: `grep -c "create index" supabase/migrations/20260701_smart_list_keyword_indexes.sql` → expect 6.
(The migration is applied to the DB out-of-band; do not attempt to run it against prod here.)

- [ ] **Step 3: Commit**
```bash
git add supabase/migrations/20260701_smart_list_keyword_indexes.sql
git commit -m "feat(audiences): pg_trgm GIN indexes for keyword-filter search"
```

---

## Task 3: Resolver — keyword resolution + pure combine helper + tests

**Files:** Create `src/lib/campaigns/keyword-match.ts` + `src/lib/__tests__/keyword-match.test.ts`; modify `src/lib/campaigns/smart-list-resolver.ts`
**Test:** `src/lib/__tests__/keyword-match.test.ts`

- [ ] **Step 1: Write the failing test for the pure combiner**
Create `src/lib/__tests__/keyword-match.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { combineTermMatches, sanitizeTerm } from '@/lib/campaigns/keyword-match'

describe('sanitizeTerm', () => {
  it('strips PostgREST-breaking characters and trims', () => {
    expect(sanitizeTerm('  fin,ancing%  ')).toBe('financing')
    expect(sanitizeTerm('a(b)c*')).toBe('abc')
  })
  it('returns empty string for whitespace-only', () => {
    expect(sanitizeTerm('   ')).toBe('')
  })
})

describe('combineTermMatches', () => {
  const a = new Set(['l1', 'l2', 'l3'])
  const b = new Set(['l2', 'l3', 'l4'])
  it('any = union across terms', () => {
    expect([...combineTermMatches([a, b], 'any')].sort()).toEqual(['l1', 'l2', 'l3', 'l4'])
  })
  it('all = intersection across terms', () => {
    expect([...combineTermMatches([a, b], 'all')].sort()).toEqual(['l2', 'l3'])
  })
  it('single term returns that set', () => {
    expect([...combineTermMatches([a], 'all')].sort()).toEqual(['l1', 'l2', 'l3'])
  })
  it('empty input returns empty set', () => {
    expect(combineTermMatches([], 'any').size).toBe(0)
    expect(combineTermMatches([], 'all').size).toBe(0)
  })
})
```

- [ ] **Step 2: Run it — verify it fails**
Run: `npx vitest run src/lib/__tests__/keyword-match.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the pure helper**
Create `src/lib/campaigns/keyword-match.ts`:
```ts
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
  // all — intersect, starting from the smallest set for efficiency
  const ordered = [...sets].sort((x, y) => x.size - y.size)
  let acc = new Set(ordered[0])
  for (let i = 1; i < ordered.length; i++) {
    const next = ordered[i]
    acc = new Set([...acc].filter((id) => next.has(id)))
    if (acc.size === 0) break
  }
  return acc
}
```

- [ ] **Step 4: Run test — verify pass**
Run: `npx vitest run src/lib/__tests__/keyword-match.test.ts` → PASS.

- [ ] **Step 5: Add `resolveKeywordLeadIds` to the resolver**
In `src/lib/campaigns/smart-list-resolver.ts`, add (below the imports, above `applySmartListCriteria`):
```ts
import { combineTermMatches, sanitizeTerm } from './keyword-match'

const LEAD_TEXT_COLUMNS = [
  'first_name', 'last_name', 'city',
  'ai_summary', 'dental_condition_details', 'current_dental_situation',
] as const

/**
 * Resolve a keyword clause to the set of matching lead IDs (org-scoped).
 * One query per (term, scope); per-term sets are unioned across scopes, then
 * combined across terms by `match` (any=union, all=intersect).
 * Returns null when there is nothing to filter (no usable terms/scopes).
 */
export async function resolveKeywordLeadIds(
  supabase: SupabaseClient,
  organizationId: string,
  keywords: NonNullable<SmartListCriteria['keywords']>
): Promise<Set<string> | null> {
  const terms = keywords.terms.map(sanitizeTerm).filter((t) => t.length > 0)
  const scopes = keywords.scopes
  if (terms.length === 0 || scopes.length === 0) return null

  const perTerm: Set<string>[] = []

  for (const term of terms) {
    const ids = new Set<string>()

    if (scopes.includes('lead_fields')) {
      const orFilter = LEAD_TEXT_COLUMNS.map((c) => `${c}.ilike.%${term}%`).join(',')
      const { data } = await supabase
        .from('leads').select('id')
        .eq('organization_id', organizationId).or(orFilter).limit(5000)
      for (const r of data || []) ids.add((r as { id: string }).id)
    }

    if (scopes.includes('conversation')) {
      const { data } = await supabase
        .from('messages').select('lead_id')
        .eq('organization_id', organizationId).ilike('body', `%${term}%`).limit(10000)
      for (const r of data || []) { const id = (r as { lead_id: string | null }).lead_id; if (id) ids.add(id) }
    }

    if (scopes.includes('inbound_sms')) {
      const { data } = await supabase
        .from('messages').select('lead_id')
        .eq('organization_id', organizationId)
        .eq('direction', 'inbound').eq('channel', 'sms')
        .ilike('body', `%${term}%`).limit(10000)
      for (const r of data || []) { const id = (r as { lead_id: string | null }).lead_id; if (id) ids.add(id) }
    }

    if (scopes.includes('tags')) {
      const { data: tagRows } = await supabase
        .from('tags').select('id')
        .eq('organization_id', organizationId).ilike('name', `%${term}%`).limit(500)
      const tagIds = (tagRows || []).map((t) => (t as { id: string }).id)
      if (tagIds.length > 0) {
        const { data: links } = await supabase
          .from('lead_tags').select('lead_id')
          .eq('organization_id', organizationId).in('tag_id', tagIds).limit(10000)
        for (const r of links || []) ids.add((r as { lead_id: string }).lead_id)
      }
    }

    perTerm.push(ids)
  }

  return combineTermMatches(perTerm, keywords.match)
}
```

- [ ] **Step 6: Integrate into `resolveSmartListLeads`**
In `resolveSmartListLeads`, after the existing tag pre-filter block computes `tagFilteredLeadIds`
(and before building the main query), add a keyword pre-filter that intersects:
```ts
  // Keyword pre-filter (same pattern as tags): resolve to lead IDs and intersect.
  if (criteria.keywords) {
    const kwSet = await resolveKeywordLeadIds(supabase, organizationId, criteria.keywords)
    if (kwSet !== null) {
      if (kwSet.size === 0) return { leadIds: [], count: 0 }
      if (tagFilteredLeadIds !== null) {
        tagFilteredLeadIds = tagFilteredLeadIds.filter((id) => kwSet.has(id))
        if (tagFilteredLeadIds.length === 0) return { leadIds: [], count: 0 }
      } else {
        tagFilteredLeadIds = [...kwSet]
      }
    }
  }
```
(This reuses the existing `tagFilteredLeadIds !== null → query.in('id', ...)` machinery, so the
main query already applies the intersected ID set.)

- [ ] **Step 7: Run the full suite + tsc**
Run: `npx vitest run` → all pass (new keyword-match tests included).
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 8: Commit**
```bash
git add src/lib/campaigns/keyword-match.ts src/lib/__tests__/keyword-match.test.ts src/lib/campaigns/smart-list-resolver.ts
git commit -m "feat(audiences): keyword resolver (conversation/lead-fields/inbound-sms/tags) with pure combiner"
```

---

## Task 4: Wire keywords into the `/smart-lists/[id]/leads` GET route

**Files:** `src/app/api/smart-lists/[id]/leads/route.ts`

The listing route resolves tags separately, then calls `applySmartListCriteria`. Keywords need
the same lead-ID intersection there.

- [ ] **Step 1: Import the keyword resolver**
Add to the imports: `resolveKeywordLeadIds` from `@/lib/campaigns/smart-list-resolver`.

- [ ] **Step 2: Intersect keyword IDs into `tagFilteredIds`**
After the existing tag-resolution block (which sets `tagFilteredIds`) and before building the main
`leads` query, add:
```ts
  // Keyword pre-filter — intersect matching lead IDs (encryption-aware; see resolver).
  if (criteria.keywords) {
    const kwSet = await resolveKeywordLeadIds(supabase, orgId, criteria.keywords)
    if (kwSet !== null) {
      if (kwSet.size === 0) {
        return NextResponse.json({ leads: [], pagination: { page, per_page: perPage, total: 0, total_pages: 0 } })
      }
      tagFilteredIds = tagFilteredIds === null ? [...kwSet] : tagFilteredIds.filter((id) => kwSet.has(id))
      if (tagFilteredIds.length === 0) {
        return NextResponse.json({ leads: [], pagination: { page, per_page: perPage, total: 0, total_pages: 0 } })
      }
    }
  }
```

- [ ] **Step 3: tsc + build check**
Run: `npx tsc --noEmit` → clean.

- [ ] **Step 4: Commit**
```bash
git add "src/app/api/smart-lists/[id]/leads/route.ts"
git commit -m "feat(audiences): apply keyword filter in the smart-list leads listing route"
```

---

## Task 5: Builder UI — keyword section

**Files:** `src/components/crm/smart-list-builder.tsx`

- [ ] **Step 1: Add keyword state**
Below the existing criteria state (after `smsConsent`), add:
```tsx
  const [keywordTerms, setKeywordTerms] = useState<string[]>(initialValues?.criteria.keywords?.terms || [])
  const [keywordInput, setKeywordInput] = useState('')
  const [keywordMatch, setKeywordMatch] = useState<'any' | 'all'>(initialValues?.criteria.keywords?.match || 'any')
  const [keywordScopes, setKeywordScopes] = useState<string[]>(
    initialValues?.criteria.keywords?.scopes || ['conversation', 'lead_fields']
  )
```

- [ ] **Step 2: Include keywords in `buildCriteria`**
In `buildCriteria()`, before `return criteria`, add:
```tsx
    if (keywordTerms.length > 0 && keywordScopes.length > 0) {
      criteria.keywords = {
        terms: keywordTerms,
        match: keywordMatch,
        scopes: keywordScopes as ('conversation' | 'lead_fields' | 'inbound_sms' | 'tags')[],
      }
    }
```

- [ ] **Step 3: Update `refreshPreview` deps + `hasCriteria`**
Add `keywordTerms, keywordMatch, keywordScopes` to the `useCallback` dependency array of
`refreshPreview`. Extend `hasCriteria` with `|| keywordTerms.length > 0`.

- [ ] **Step 4: Add the keyword UI**
Inside the Filter Criteria block (after the Tags Filter `div`, before AI Qualification), add:
```tsx
            {/* Keyword Filter */}
            <div className="space-y-2">
              <Label className="text-[13px]">Keywords</Label>
              <div className="flex items-center gap-2">
                <Input
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && keywordInput.trim()) {
                      e.preventDefault()
                      const t = keywordInput.trim()
                      if (!keywordTerms.includes(t)) setKeywordTerms([...keywordTerms, t])
                      setKeywordInput('')
                    }
                  }}
                  placeholder="Type a term, press Enter (e.g. financing)"
                  className="flex-1"
                />
                {keywordTerms.length > 1 && (
                  <Select value={keywordMatch} onValueChange={(v) => setKeywordMatch(v as 'any' | 'all')}>
                    <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any</SelectItem>
                      <SelectItem value="all">All</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
              {keywordTerms.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {keywordTerms.map((t) => (
                    <button
                      key={t}
                      onClick={() => setKeywordTerms(keywordTerms.filter((x) => x !== t))}
                      className="inline-flex items-center gap-1 rounded-full border border-aurea-primary/30 bg-aurea-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-aurea-primary"
                    >
                      {t} <span aria-hidden>×</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5 pt-1">
                {[
                  { key: 'conversation', label: 'Conversations' },
                  { key: 'lead_fields', label: 'Lead details' },
                  { key: 'inbound_sms', label: 'Inbound replies' },
                  { key: 'tags', label: 'Tags' },
                ].map((s) => {
                  const active = keywordScopes.includes(s.key)
                  return (
                    <button
                      key={s.key}
                      onClick={() => toggleArrayValue(keywordScopes, s.key, setKeywordScopes)}
                      className={cn(
                        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors',
                        active
                          ? 'bg-aurea-primary/10 text-aurea-primary border-aurea-primary/30'
                          : 'bg-aurea-surface border-aurea-border text-aurea-ink-3 hover:bg-aurea-surface-2'
                      )}
                    >
                      {s.label}
                    </button>
                  )
                })}
              </div>
              {keywordTerms.length > 0 && keywordScopes.length === 0 && (
                <p className="text-[11px] text-aurea-rose">Pick at least one place to search.</p>
              )}
            </div>
```

- [ ] **Step 5: tsc + build**
Run: `npx tsc --noEmit` → clean. Confirm the component compiles.

- [ ] **Step 6: Commit**
```bash
git add src/components/crm/smart-list-builder.tsx
git commit -m "feat(audiences): keyword filter UI (terms, any/all, scope selection)"
```

---

## Task 6: Verify + PR

- [ ] **Step 1:** `npx vitest run` → all pass.
- [ ] **Step 2:** `rm -rf .next && npm run build` → compiles.
- [ ] **Step 3:** Push branch, open PR to `main` with a summary of the keyword filter, the
  encryption-aware scope decision, and the new indexes.

---

## Notes for reviewers
- The `lead_fields` scope deliberately excludes encrypted email/phone (only plaintext columns).
- PostgREST `.or()` is built from sanitized terms (`sanitizeTerm` strips `, % ( ) *`).
- Per-(term,scope) queries are capped (`.limit()`), consistent with the resolver's existing
  1000-ID `.in()` ceiling; document the cap rather than silently truncating at larger scale.
