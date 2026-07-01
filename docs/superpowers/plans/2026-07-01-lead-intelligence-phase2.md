# Lead Intelligence Surface (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Surface the already-built AI intelligence (`patient_profiles` + `conversation_analyses`) at the top of the lead **Channel** tab, with a one-click "Run analysis" action that calls the existing `POST /api/ai/analyze`.

**Architecture:** ACTIVATION, not net-new. The engine already exists: `analyzePatientPsychology()` (per-lead summary, next-best-action, recommended tone, objections) and `analyzeConversation()` (tone, engagement, red flags, opportunities) both run via `POST /api/ai/analyze` and persist to `patient_profiles` / `conversation_analyses` (migration `005_patient_intelligence.sql`). Phase 2 adds a read (server page fetches the latest of each), a presentational `<LeadIntelligencePanel>`, and a client action that POSTs to the existing route then refreshes. One pure helper — `pickConversationToAnalyze()` — decides which conversation to feed the analyzer. **No migration. No new prompts.**

**Tech Stack:** Next.js 16, TypeScript, Supabase, vitest, shadcn/ui, lucide-react.

---

## File structure (locked)

- Create: `src/lib/timeline/pick-conversation.ts` — pure `pickConversationToAnalyze()`.
- Create: `src/lib/__tests__/pick-conversation.test.ts` — vitest.
- Create: `src/components/crm/lead-intelligence-panel.tsx` — client panel + Run analysis.
- Modify: `src/app/(dashboard)/leads/[id]/page.tsx` — fetch `patient_profiles` + latest `conversation_analyses`, compute analyzable conversation id, pass down.
- Modify: `src/components/crm/lead-detail.tsx` — new props + render panel atop the Channel tab.

**Contracts (verified 2026-07-01):**
- `POST /api/ai/analyze` body `{ conversation_id, lead_id }` → `{ conversation_analysis, patient_profile, warnings? }`. Requires the conversation to have ≥2 messages.
- `PatientProfile` (types): `ai_summary`, `next_best_action`, `recommended_tone`, `topics_to_avoid[]`, `topics_to_emphasize[]`, `objections[]`, `pain_points[]`, `rapport_score`, `emotional_state`, `last_analyzed_at`.
- `ConversationAnalysis` (types): `patient_tone`, `engagement_score`, `trust_score`, `red_flags[]`, `opportunities[]`, `coaching_notes`, `analyzed_at`.

---

### Task 1: pickConversationToAnalyze (pure) — TDD

**Files:**
- Create: `src/lib/timeline/pick-conversation.ts`
- Test: `src/lib/__tests__/pick-conversation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/pick-conversation.test.ts
import { describe, it, expect } from 'vitest'
import { pickConversationToAnalyze } from '@/lib/timeline/pick-conversation'

describe('pickConversationToAnalyze', () => {
  it('returns null when there are no conversations', () => {
    expect(pickConversationToAnalyze([])).toBeNull()
  })

  it('returns null when no conversation has at least 2 messages', () => {
    expect(pickConversationToAnalyze([
      { id: 'c1', message_count: 1, last_message_at: '2026-06-01T10:00:00Z', status: 'active' },
    ])).toBeNull()
  })

  it('prefers an active conversation over a closed one with a newer message', () => {
    expect(pickConversationToAnalyze([
      { id: 'closed', message_count: 5, last_message_at: '2026-06-02T10:00:00Z', status: 'closed' },
      { id: 'active', message_count: 3, last_message_at: '2026-06-01T10:00:00Z', status: 'active' },
    ])).toBe('active')
  })

  it('picks the most recently active conversation among eligible ones', () => {
    expect(pickConversationToAnalyze([
      { id: 'old', message_count: 4, last_message_at: '2026-06-01T10:00:00Z', status: 'active' },
      { id: 'new', message_count: 2, last_message_at: '2026-06-03T10:00:00Z', status: 'active' },
    ])).toBe('new')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/pick-conversation.test.ts`
Expected: FAIL — "Cannot find module '@/lib/timeline/pick-conversation'".

- [ ] **Step 3: Implement**

```ts
// src/lib/timeline/pick-conversation.ts
import type { Conversation } from '@/types/database'

/**
 * Choose which conversation to feed the AI analyzer: it needs ≥2 messages
 * (per /api/ai/analyze), and we prefer an active conversation, then the most
 * recent by last_message_at. Returns null when nothing is analyzable.
 */
export function pickConversationToAnalyze(
  conversations: Pick<Conversation, 'id' | 'message_count' | 'last_message_at' | 'status'>[]
): string | null {
  const eligible = conversations.filter((c) => (c.message_count ?? 0) >= 2)
  if (eligible.length === 0) return null

  const sorted = [...eligible].sort((a, b) => {
    const aActive = a.status === 'active' ? 1 : 0
    const bActive = b.status === 'active' ? 1 : 0
    if (aActive !== bActive) return bActive - aActive
    const at = a.last_message_at ?? ''
    const bt = b.last_message_at ?? ''
    return at < bt ? 1 : at > bt ? -1 : 0
  })

  return sorted[0].id
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/pick-conversation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/timeline/pick-conversation.ts src/lib/__tests__/pick-conversation.test.ts
git commit -m "feat(intelligence): pure pickConversationToAnalyze with tests"
```

---

### Task 2: LeadIntelligencePanel component

**Files:**
- Create: `src/components/crm/lead-intelligence-panel.tsx`

- [ ] **Step 1: Implement** (see full code in the executing session; renders `PatientProfile` + latest `ConversationAnalysis`, with a Run analysis button that POSTs `/api/ai/analyze` `{ conversation_id: analyzableConversationId, lead_id }` and `router.refresh()`; disabled with a hint when `analyzableConversationId` is null).

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → PASS.
- [ ] **Step 3: Commit** — `feat(intelligence): LeadIntelligencePanel (summary, tone, next-best-action)`.

---

### Task 3: Fetch intelligence in the page + wire the panel into the Channel tab

**Files:**
- Modify: `src/app/(dashboard)/leads/[id]/page.tsx` — fetch `patient_profiles` (maybeSingle by lead_id), latest `conversation_analyses` (order analyzed_at desc, limit 1), compute `pickConversationToAnalyze(conversations)`, pass `patientProfile` / `latestAnalysis` / `analyzableConversationId` to `<LeadDetail>`.
- Modify: `src/components/crm/lead-detail.tsx` — add the three props; render `<LeadIntelligencePanel>` above `<LeadTimeline>` in the `channel` tab.

- [ ] **Step 1–4:** implement edits, `npx tsc --noEmit` → PASS, then commit `feat(intelligence): surface AI intelligence atop the Channel tab`.

---

### Task 4: Full verification

- [ ] `npm run test` → all green (adds pick-conversation suite).
- [ ] `npx tsc --noEmit` → clean.
- [ ] `preview_start` (lead-crm) → dev server compiles with no build errors.
- [ ] `npm run lint` → no new errors.

## Self-review notes

- **Reuse over rebuild:** no migration, no new prompts — activates `patient_profiles` / `conversation_analyses` via the existing `/api/ai/analyze`.
- **Type consistency:** `pickConversationToAnalyze` is used identically in page + test; panel reads `PatientProfile` / `ConversationAnalysis` straight from `@/types/database`.
