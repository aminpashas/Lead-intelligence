# SMS Training Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator train the AI over SMS from an allowlisted phone — roleplay against it and correct it — with corrections saved as agency-wide rules that immediately govern live patient conversations.

**Architecture:** A command interceptor in the Twilio webhook (before the lead lookup, mirroring the existing STOP/START handlers) routes messages from allowlisted trainer numbers into a two-mode state machine. **ROLEPLAY** reuses `generateRolePlayResponse` with the AI as patient; **TRAIN** (dry-run) reuses the same engine with the AI as coordinator — extended so its prompt includes the agency rules + persona, giving the same trained "brain" with **zero tool side effects** (we deliberately do NOT call the live tool-executing `routeToAgent` against a non-existent lead). Corrections persist to a new agency-wide `agency_ai_rules` table, injected into every live setter/closer prompt via `buildAgencyRulesBlock`.

**Tech Stack:** Next.js 16 route handlers, Supabase (Postgres + RLS), Anthropic SDK (via existing roleplay engine), Twilio SMS, Vitest, Zod. Multi-tenant patterns per `CLAUDE.md`.

---

## File Structure

**New files**
- `supabase/migrations/20260701_sms_training.sql` — `agency_ai_rules` + `sms_training_sessions` tables + RLS.
- `src/lib/ai/agency-rules.ts` — agency-rule persistence + `buildAgencyRulesBlock` (the live-agent injection) + pure formatters.
- `src/lib/autopilot/sms-training.ts` — command parser (pure), trainer config/allowlist/PIN, session store, and the `handleTrainerSms` orchestrator.
- `src/lib/ai/__tests__/agency-rules.test.ts` — formatter + derive-fields tests.
- `src/lib/autopilot/__tests__/sms-training.test.ts` — parser + allowlist + normalize tests.

**Modified files**
- `src/types/database.ts` — `AgencyAiRule`, `SmsTrainingSession` types.
- `src/lib/ai/roleplay-engine.ts` — TC branch of `generateRolePlayResponse`/`generateRolePlayRetry` includes agency rules + persona; add exported `findScenario`.
- `src/lib/ai/setter-agent.ts` (line 360-363 + 392) — inject `buildAgencyRulesBlock`.
- `src/lib/ai/closer-agent.ts` (line 569-577 + 591) — inject `buildAgencyRulesBlock`.
- `src/app/api/webhooks/twilio/route.ts` — training intercept before the lead lookup.

**Naming contract (used across tasks):**
- Types: `AgencyAiRule`, `SmsTrainingSession`.
- `agency-rules.ts`: `formatRulesBlock`, `buildAgencyRulesBlock`, `deriveRuleFields`, `createAgencyRule`.
- `sms-training.ts`: `ParsedCommand`, `parseTrainerCommand`, `normalizeE164`, `isTrainerNumber`, `getTrainerConfig`, `getActiveSession`, `openSession`, `appendTurn`, `endSession`, `handleTrainerSms`, `HELP_TEXT`.
- `roleplay-engine.ts`: `findScenario`.

---

### Task 1: Database migration

**Files:**
- Create: `supabase/migrations/20260701_sms_training.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ═══════════════════════════════════════════════════════════════
-- SMS Training Console
-- ═══════════════════════════════════════════════════════════════
-- agency_ai_rules: agency-WIDE durable rules authored over SMS. Unlike
-- ai_memories (org-scoped) these have NO organization_id — they are injected
-- into every practice's live setter/closer prompt via buildAgencyRulesBlock.
-- sms_training_sessions: per-trainer-phone state between stateless webhook hits.

CREATE TABLE IF NOT EXISTS public.agency_ai_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title        text NOT NULL,
  content      text NOT NULL,
  category     text NOT NULL DEFAULT 'general',
  priority     int  NOT NULL DEFAULT 100,   -- higher = injected earlier
  is_enabled   boolean NOT NULL DEFAULT true,
  source       text NOT NULL DEFAULT 'sms_training',
  created_by   text,                         -- trainer phone (E.164)
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agency_ai_rules ENABLE ROW LEVEL SECURITY;

-- Only agency_admin can read/write via the anon/auth client. The service role
-- (used by the live agents in the webhook path) bypasses RLS entirely.
CREATE POLICY "Agency admins can manage agency ai rules"
  ON public.agency_ai_rules FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND role = 'agency_admin'
    )
  );

CREATE TABLE IF NOT EXISTS public.sms_training_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_phone     text NOT NULL,                 -- E.164, plain (operator infra, not patient PHI)
  mode              text NOT NULL,                 -- 'roleplay' | 'dry_run'
  scenario_key      text,
  patient_persona   jsonb,
  reference_org_id  uuid,
  transcript        jsonb NOT NULL DEFAULT '[]',    -- [{role, content}]
  rules_saved       int NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'active', -- 'active' | 'ended'
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_activity_at  timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);

-- At most one active session per trainer phone.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_session_per_phone
  ON public.sms_training_sessions (trainer_phone) WHERE status = 'active';

ALTER TABLE public.sms_training_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agency admins can manage sms training sessions"
  ON public.sms_training_sessions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid() AND role = 'agency_admin'
    )
  );
```

- [ ] **Step 2: Verify SQL parses locally (dry check)**

Run: `grep -c "CREATE TABLE" supabase/migrations/20260701_sms_training.sql`
Expected: `2`

(The project applies migrations via Supabase; do not run a live migration here. A reviewer applies it in staging.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260701_sms_training.sql
git commit -m "feat(sms-training): migration for agency_ai_rules + sms_training_sessions"
```

---

### Task 2: Database types

**Files:**
- Modify: `src/types/database.ts` (append near the existing AI training types, e.g. after `AIRolePlaySession`)

- [ ] **Step 1: Add the types**

```typescript
export type AgencyAiRule = {
  id: string
  title: string
  content: string
  category: string
  priority: number
  is_enabled: boolean
  source: string
  created_by: string | null
  created_at: string
}

export type SmsTrainingMode = 'roleplay' | 'dry_run'

export type SmsTrainingSession = {
  id: string
  trainer_phone: string
  mode: SmsTrainingMode
  scenario_key: string | null
  patient_persona: Record<string, unknown> | null
  reference_org_id: string | null
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>
  rules_saved: number
  status: 'active' | 'ended'
  started_at: string
  last_activity_at: string
  ended_at: string | null
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors from these additions)

- [ ] **Step 3: Commit**

```bash
git add src/types/database.ts
git commit -m "feat(sms-training): add AgencyAiRule + SmsTrainingSession types"
```

---

### Task 3: Agency-rules module (pure formatter + derive-fields, TDD)

**Files:**
- Create: `src/lib/ai/agency-rules.ts`
- Test: `src/lib/ai/__tests__/agency-rules.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { formatRulesBlock, deriveRuleFields } from '@/lib/ai/agency-rules'

describe('formatRulesBlock', () => {
  it('returns empty string when there are no rules', () => {
    expect(formatRulesBlock([])).toBe('')
  })

  it('renders a heading + each rule as ### title [category]\\ncontent', () => {
    const block = formatRulesBlock([
      { title: 'Competitor pricing', category: 'objection', content: 'Lead with value, never match price.' },
    ])
    expect(block.startsWith('## Agency Rules')).toBe(true)
    expect(block).toContain('### Competitor pricing [objection]')
    expect(block).toContain('Lead with value, never match price.')
  })
})

describe('deriveRuleFields', () => {
  it('derives a truncated title, general category, priority 100, full content', () => {
    const r = deriveRuleFields('When a patient mentions a cheaper competitor, acknowledge value and never match price.')
    expect(r.title.length).toBeLessThanOrEqual(60)
    expect(r.title.startsWith('When a patient mentions a cheaper')).toBe(true)
    expect(r.category).toBe('general')
    expect(r.priority).toBe(100)
    expect(r.content).toContain('never match price')
  })

  it('trims whitespace', () => {
    expect(deriveRuleFields('  be warm  ').content).toBe('be warm')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/ai/__tests__/agency-rules.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/ai/agency-rules'"

- [ ] **Step 3: Write the module**

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgencyAiRule } from '@/types/database'

type RuleForBlock = Pick<AgencyAiRule, 'title' | 'category' | 'content'>

/** Pure formatter: renders enabled rules into a system-prompt block. Empty-safe. */
export function formatRulesBlock(rules: RuleForBlock[]): string {
  if (rules.length === 0) return ''
  const body = rules.map((r) => `### ${r.title} [${r.category}]\n${r.content}`).join('\n\n')
  return `## Agency Rules\nThese rules apply to EVERY practice and override softer guidance below when they conflict:\n\n${body}`
}

/** Derive DB fields from a raw SMS rule text. First ~8 words → title. */
export function deriveRuleFields(text: string): {
  title: string
  content: string
  category: string
  priority: number
} {
  const content = text.trim()
  const title = content.split(/\s+/).slice(0, 8).join(' ').slice(0, 60)
  return { title, content, category: 'general', priority: 100 }
}

/**
 * Assemble the agency-wide rules block for the LIVE setter/closer agents.
 * Reads with whatever client is passed (service role in the webhook path, so
 * RLS is bypassed). Returns '' when there are no enabled rules.
 */
export async function buildAgencyRulesBlock(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase
    .from('agency_ai_rules')
    .select('title, category, content')
    .eq('is_enabled', true)
    .order('priority', { ascending: false })
  return formatRulesBlock((data as RuleForBlock[]) || [])
}

/** Persist a new agency rule authored over SMS. */
export async function createAgencyRule(
  supabase: SupabaseClient,
  params: { text: string; createdBy: string }
): Promise<void> {
  const fields = deriveRuleFields(params.text)
  await supabase.from('agency_ai_rules').insert({
    ...fields,
    source: 'sms_training',
    created_by: params.createdBy,
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/ai/__tests__/agency-rules.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/ai/agency-rules.ts src/lib/ai/__tests__/agency-rules.test.ts
git commit -m "feat(sms-training): agency-rules module + buildAgencyRulesBlock"
```

---

### Task 4: Inject agency rules into the live agents

**Files:**
- Modify: `src/lib/ai/setter-agent.ts` (line 360-363 and 392)
- Modify: `src/lib/ai/closer-agent.ts` (line 569-577 and 591)

- [ ] **Step 1: Import the builder in setter-agent.ts**

Change the existing import (currently `import { buildLiveAgentKnowledgeBlock, buildAgencyPersonaBlock } from '@/lib/ai/training-context'`) to ALSO import the new builder — add this line after it:

```typescript
import { buildAgencyRulesBlock } from '@/lib/ai/agency-rules'
```

- [ ] **Step 2: Add the block to the parallel fetch (setter-agent.ts ~line 360)**

Replace:

```typescript
  const [knowledgeBlock, personaBlock] = await Promise.all([
    buildLiveAgentKnowledgeBlock(supabase, context.organization_id, latestInbound),
    buildAgencyPersonaBlock(supabase),
  ])
```

with:

```typescript
  const [knowledgeBlock, personaBlock, rulesBlock] = await Promise.all([
    buildLiveAgentKnowledgeBlock(supabase, context.organization_id, latestInbound),
    buildAgencyPersonaBlock(supabase),
    buildAgencyRulesBlock(supabase),
  ])
```

- [ ] **Step 3: Add the block to the prompt assembly (setter-agent.ts line 392)**

Replace:

```typescript
  const systemPrompt = [composedPrompt, discoveryBlock, pricingBlock, personaBlock, knowledgeBlock].filter(Boolean).join('\n\n')
```

with:

```typescript
  const systemPrompt = [composedPrompt, discoveryBlock, pricingBlock, personaBlock, rulesBlock, knowledgeBlock].filter(Boolean).join('\n\n')
```

- [ ] **Step 4: Repeat for closer-agent.ts — import**

Add after the existing training-context import:

```typescript
import { buildAgencyRulesBlock } from '@/lib/ai/agency-rules'
```

- [ ] **Step 5: closer-agent.ts parallel fetch (~line 569)**

Replace:

```typescript
  const [knowledgeBlock, personaBlock, bookingSettings] = await Promise.all([
    buildLiveAgentKnowledgeBlock(supabase, context.organization_id, latestInbound),
    buildAgencyPersonaBlock(supabase),
    supabase
      .from('booking_settings')
      .select('consult_price_range_text')
      .eq('organization_id', context.organization_id)
      .maybeSingle(),
  ])
```

with:

```typescript
  const [knowledgeBlock, personaBlock, bookingSettings, rulesBlock] = await Promise.all([
    buildLiveAgentKnowledgeBlock(supabase, context.organization_id, latestInbound),
    buildAgencyPersonaBlock(supabase),
    supabase
      .from('booking_settings')
      .select('consult_price_range_text')
      .eq('organization_id', context.organization_id)
      .maybeSingle(),
    buildAgencyRulesBlock(supabase),
  ])
```

- [ ] **Step 6: closer-agent.ts prompt assembly (line 591)**

Replace:

```typescript
  const systemPrompt = [composedPrompt, pricingBlock, personaBlock, knowledgeBlock].filter(Boolean).join('\n\n')
```

with:

```typescript
  const systemPrompt = [composedPrompt, pricingBlock, personaBlock, rulesBlock, knowledgeBlock].filter(Boolean).join('\n\n')
```

- [ ] **Step 7: Type-check + run existing agent/knowledge tests**

Run: `npx tsc --noEmit && npx vitest run src/lib/__tests__/live-agent-knowledge.test.ts`
Expected: PASS (no type errors; existing tests still green)

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai/setter-agent.ts src/lib/ai/closer-agent.ts
git commit -m "feat(sms-training): inject agency rules into live setter + closer prompts"
```

---

### Task 5: Command parser (pure, TDD)

**Files:**
- Create: `src/lib/autopilot/sms-training.ts` (parser + types first; more added in later tasks)
- Test: `src/lib/autopilot/__tests__/sms-training.test.ts`

- [ ] **Step 1: Write the failing parser tests**

```typescript
import { describe, it, expect } from 'vitest'
import { parseTrainerCommand, normalizeE164, isTrainerNumber } from '@/lib/autopilot/sms-training'

describe('parseTrainerCommand', () => {
  it('parses TRAIN with a pin', () => {
    expect(parseTrainerCommand('TRAIN 4821')).toEqual({ kind: 'train', pin: '4821' })
  })
  it('parses ROLEPLAY with pin + scenario', () => {
    expect(parseTrainerCommand('ROLEPLAY 4821 cost objection')).toEqual({
      kind: 'roleplay', pin: '4821', scenario: 'cost objection',
    })
  })
  it('parses ROLEPLAY with pin only (no scenario)', () => {
    expect(parseTrainerCommand('roleplay 4821')).toEqual({ kind: 'roleplay', pin: '4821', scenario: null })
  })
  it('parses RULE with the remaining text', () => {
    expect(parseTrainerCommand('RULE never quote a price before booking')).toEqual({
      kind: 'rule', text: 'never quote a price before booking',
    })
  })
  it('parses FIX with guidance', () => {
    expect(parseTrainerCommand('FIX be warmer and shorter')).toEqual({ kind: 'fix', guidance: 'be warmer and shorter' })
  })
  it('parses bare control words case-insensitively', () => {
    expect(parseTrainerCommand('save')).toEqual({ kind: 'save' })
    expect(parseTrainerCommand('DONE')).toEqual({ kind: 'done' })
    expect(parseTrainerCommand('exit')).toEqual({ kind: 'done' })
    expect(parseTrainerCommand('HELP')).toEqual({ kind: 'help' })
    expect(parseTrainerCommand('status')).toEqual({ kind: 'status' })
  })
  it('treats anything else as free text', () => {
    expect(parseTrainerCommand('I want to know about the cost')).toEqual({
      kind: 'text', text: 'I want to know about the cost',
    })
  })
  it('does NOT treat STOP as an exit (reserved TCPA opt-out passes through as text)', () => {
    expect(parseTrainerCommand('STOP')).toEqual({ kind: 'text', text: 'STOP' })
  })
})

describe('normalizeE164 / isTrainerNumber', () => {
  it('normalizes US 10- and 11-digit numbers to E.164', () => {
    expect(normalizeE164('4156767420')).toBe('+14156767420')
    expect(normalizeE164('14156767420')).toBe('+14156767420')
    expect(normalizeE164('+1 (415) 676-7420')).toBe('+14156767420')
  })
  it('matches against an allowlist regardless of formatting', () => {
    const allow = ['+14156767420']
    expect(isTrainerNumber('4156767420', allow)).toBe(true)
    expect(isTrainerNumber('+14156767420', allow)).toBe(true)
    expect(isTrainerNumber('+15550001111', allow)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/autopilot/__tests__/sms-training.test.ts`
Expected: FAIL — "Failed to resolve import '@/lib/autopilot/sms-training'"

- [ ] **Step 3: Write the parser + phone helpers (top of sms-training.ts)**

```typescript
import type { SupabaseClient } from '@supabase/supabase-js'

// ── Command grammar ─────────────────────────────────────────────
export type ParsedCommand =
  | { kind: 'train'; pin: string | null }
  | { kind: 'roleplay'; pin: string | null; scenario: string | null }
  | { kind: 'rule'; text: string }
  | { kind: 'fix'; guidance: string }
  | { kind: 'save' }
  | { kind: 'done' }
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'text'; text: string }

/** Pure: classify an inbound SMS body by its first token. STOP is NOT an exit. */
export function parseTrainerCommand(body: string): ParsedCommand {
  const trimmed = body.trim()
  const [firstRaw, ...rest] = trimmed.split(/\s+/)
  const first = (firstRaw || '').toLowerCase()
  const remainder = rest.join(' ').trim()

  switch (first) {
    case 'train':
      return { kind: 'train', pin: rest[0] || null }
    case 'roleplay': {
      const pin = rest[0] || null
      const scenario = rest.slice(1).join(' ').trim() || null
      return { kind: 'roleplay', pin, scenario }
    }
    case 'rule':
      return { kind: 'rule', text: remainder }
    case 'fix':
      return { kind: 'fix', guidance: remainder }
    case 'save':
      return { kind: 'save' }
    case 'done':
    case 'exit':
      return { kind: 'done' }
    case 'help':
      return { kind: 'help' }
    case 'status':
      return { kind: 'status' }
    default:
      return { kind: 'text', text: trimmed }
  }
}

/** Best-effort E.164 for US numbers; leaves already-+ numbers as digit-normalized. */
export function normalizeE164(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return '+' + digits.slice(1).replace(/\D/g, '')
  const d = digits.replace(/\D/g, '')
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d.startsWith('1')) return '+' + d
  return '+' + d
}

export function isTrainerNumber(from: string, allowlist: string[]): boolean {
  const target = normalizeE164(from)
  return allowlist.map(normalizeE164).includes(target)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/autopilot/__tests__/sms-training.test.ts`
Expected: PASS (all parser + phone tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/autopilot/sms-training.ts src/lib/autopilot/__tests__/sms-training.test.ts
git commit -m "feat(sms-training): SMS command parser + phone allowlist helpers"
```

---

### Task 6: Trainer config (allowlist / PIN / reference org)

**Files:**
- Modify: `src/lib/autopilot/sms-training.ts` (append)

- [ ] **Step 1: Add the config loader**

```typescript
export type TrainerConfig = {
  numbers: string[]
  pin: string | null
  referenceOrgId: string | null
}

/**
 * Load trainer allowlist + PIN + reference org from agency_settings, with an
 * env fallback for the number list (SMS_TRAINER_NUMBERS="+1...,+1...").
 * Keys: 'sms_trainer_numbers' (jsonb string[]), 'training_pin' (jsonb string),
 * 'training_reference_org' (jsonb string uuid).
 */
export async function getTrainerConfig(supabase: SupabaseClient): Promise<TrainerConfig> {
  const { data } = await supabase
    .from('agency_settings')
    .select('key, value')
    .in('key', ['sms_trainer_numbers', 'training_pin', 'training_reference_org'])

  const byKey = new Map((data || []).map((r: { key: string; value: unknown }) => [r.key, r.value]))

  const envNumbers = (process.env.SMS_TRAINER_NUMBERS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const dbNumbers = Array.isArray(byKey.get('sms_trainer_numbers'))
    ? (byKey.get('sms_trainer_numbers') as string[])
    : []
  const numbers = [...new Set([...dbNumbers, ...envNumbers])]

  const pinRaw = byKey.get('training_pin')
  const pin = typeof pinRaw === 'string' && pinRaw.trim() ? pinRaw.trim() : null

  const refRaw = byKey.get('training_reference_org')
  const referenceOrgId = typeof refRaw === 'string' && refRaw.trim() ? refRaw.trim() : null

  return { numbers, pin, referenceOrgId }
}

/**
 * Resolve the org id used purely to give dry-run/roleplay generation realistic
 * context. Prefers the configured reference org; falls back to the first
 * practice org (agency-wide training still SAVES rules with no org).
 */
export async function resolveReferenceOrg(
  supabase: SupabaseClient,
  configured: string | null
): Promise<string | null> {
  if (configured) return configured
  const { data } = await supabase
    .from('organizations')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data?.id as string) || null
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/autopilot/sms-training.ts
git commit -m "feat(sms-training): trainer config loader (allowlist, PIN, reference org)"
```

---

### Task 7: `findScenario` + roleplay TC prompt includes agency rules/persona

**Files:**
- Modify: `src/lib/ai/roleplay-engine.ts`
- Test: `src/lib/ai/__tests__/agency-rules.test.ts` (append a `findScenario` test)

- [ ] **Step 1: Add a failing test for `findScenario`**

Append to `src/lib/ai/__tests__/agency-rules.test.ts`:

```typescript
import { findScenario } from '@/lib/ai/roleplay-engine'

describe('findScenario', () => {
  it('fuzzy-matches a built-in scenario by words in its name', () => {
    expect(findScenario('cost objection')?.id).toBe('cost-objection')
    expect(findScenario('anxious')?.id).toBe('anxious-patient')
  })
  it('returns the default new-patient scenario for empty/unknown input', () => {
    expect(findScenario('')?.id).toBe('new-patient-sms')
    expect(findScenario('nonsense zzz')?.id).toBe('new-patient-sms')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/ai/__tests__/agency-rules.test.ts -t findScenario`
Expected: FAIL — `findScenario` is not exported

- [ ] **Step 3: Add `findScenario` to roleplay-engine.ts**

Add after the `BUILT_IN_SCENARIOS` array:

```typescript
/**
 * Fuzzy-match a scenario by name for the SMS `ROLEPLAY <scenario>` command.
 * Falls back to the first built-in (new-patient-sms) for empty/unknown input.
 */
export function findScenario(input: string): RolePlayScenario {
  const q = input.trim().toLowerCase()
  const fallback = BUILT_IN_SCENARIOS[0]
  if (!q) return fallback
  const words = q.split(/\s+/)
  const hit = BUILT_IN_SCENARIOS.find((s) => {
    const hay = `${s.name} ${s.category}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
  return hit || fallback
}
```

- [ ] **Step 4: Extend the TC prompt to include agency rules + persona**

In `roleplay-engine.ts`, `buildTCPrompt` currently takes `(agentTarget, memories, articles, scenarioDescription)`. Add a fifth param and append the blocks. Change the signature and the two call sites inside `generateRolePlayResponse` / `generateRolePlayRetry`.

Update `buildTCPrompt` signature + tail:

```typescript
function buildTCPrompt(
  agentTarget: RolePlayAgentTarget,
  memories: { title: string; content: string; category: string }[],
  articles: { title: string; content: string }[],
  scenarioDescription: string | null,
  governanceBlocks: string[] = []
): string {
  // ... existing body unchanged, up to the final `return basePrompt` ...

  for (const block of governanceBlocks) {
    if (block) basePrompt += `\n\n${block}`
  }

  return basePrompt
}
```

- [ ] **Step 5: Pass the blocks from `generateRolePlayResponse` (the AI-as-TC branch)**

In `generateRolePlayResponse`, the `else` branch (user is patient → AI plays TC) currently builds memories/articles then calls `buildTCPrompt(...)`. Replace that block with one that also fetches the agency blocks and passes them:

```typescript
  } else {
    // User is patient → AI plays as TC
    const { buildAgencyRulesBlock } = await import('./agency-rules')
    const { buildAgencyPersonaBlock } = await import('./training-context')
    const lastMsg = session.messages[session.messages.length - 1]?.content || ''
    const [memories, articles, rulesBlock, personaBlock] = await Promise.all([
      getActiveMemories(supabase, orgId),
      getRelevantKnowledge(supabase, orgId, lastMsg),
      buildAgencyRulesBlock(supabase),
      buildAgencyPersonaBlock(supabase),
    ])
    systemPrompt = buildTCPrompt(
      session.agent_target,
      memories.map(m => ({ title: m.title, content: m.content, category: m.category })),
      articles.map(a => ({ title: a.title, content: a.content })),
      session.scenario_description,
      [personaBlock, rulesBlock]
    )
  }
```

- [ ] **Step 6: Mirror the same change in `generateRolePlayRetry`'s TC branch**

Apply the identical replacement to the `else` branch of `generateRolePlayRetry` (same four-way `Promise.all`, same `buildTCPrompt(..., [personaBlock, rulesBlock])` call).

- [ ] **Step 7: Run tests + type-check**

Run: `npx tsc --noEmit && npx vitest run src/lib/ai/__tests__/agency-rules.test.ts`
Expected: PASS (findScenario tests green; nothing else broke)

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai/roleplay-engine.ts src/lib/ai/__tests__/agency-rules.test.ts
git commit -m "feat(sms-training): findScenario + agency rules/persona in roleplay TC prompt"
```

---

### Task 8: Session store helpers

**Files:**
- Modify: `src/lib/autopilot/sms-training.ts` (append)

- [ ] **Step 1: Add the session store**

```typescript
import type { SmsTrainingSession, SmsTrainingMode } from '@/types/database'

const IDLE_TTL_MS = 6 * 60 * 60 * 1000 // 6h

/** Load the active session for a phone, lazily ending it if idle past the TTL. */
export async function getActiveSession(
  supabase: SupabaseClient,
  trainerPhone: string
): Promise<SmsTrainingSession | null> {
  const { data } = await supabase
    .from('sms_training_sessions')
    .select('*')
    .eq('trainer_phone', trainerPhone)
    .eq('status', 'active')
    .maybeSingle()

  const session = data as SmsTrainingSession | null
  if (!session) return null

  const idleMs = Date.now() - new Date(session.last_activity_at).getTime()
  if (idleMs > IDLE_TTL_MS) {
    await endSession(supabase, session.id)
    return null
  }
  return session
}

export async function openSession(
  supabase: SupabaseClient,
  params: {
    trainerPhone: string
    mode: SmsTrainingMode
    scenarioKey: string | null
    patientPersona: Record<string, unknown> | null
    referenceOrgId: string | null
    transcript: Array<{ role: 'user' | 'assistant'; content: string }>
  }
): Promise<SmsTrainingSession> {
  const { data } = await supabase
    .from('sms_training_sessions')
    .insert({
      trainer_phone: params.trainerPhone,
      mode: params.mode,
      scenario_key: params.scenarioKey,
      patient_persona: params.patientPersona,
      reference_org_id: params.referenceOrgId,
      transcript: params.transcript,
    })
    .select('*')
    .single()
  return data as SmsTrainingSession
}

/** Append messages to the transcript and bump last_activity_at. */
export async function appendTurn(
  supabase: SupabaseClient,
  session: SmsTrainingSession,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  extra: Partial<Pick<SmsTrainingSession, 'rules_saved'>> = {}
): Promise<SmsTrainingSession> {
  const transcript = [...session.transcript, ...messages]
  const { data } = await supabase
    .from('sms_training_sessions')
    .update({ transcript, last_activity_at: new Date().toISOString(), ...extra })
    .eq('id', session.id)
    .select('*')
    .single()
  return data as SmsTrainingSession
}

export async function endSession(supabase: SupabaseClient, sessionId: string): Promise<void> {
  await supabase
    .from('sms_training_sessions')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', sessionId)
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/lib/autopilot/sms-training.ts
git commit -m "feat(sms-training): session store (open/get/append/end with idle expiry)"
```

---

### Task 9: Orchestrator `handleTrainerSms`

**Files:**
- Modify: `src/lib/autopilot/sms-training.ts` (append)
- Test: `src/lib/autopilot/__tests__/sms-training.test.ts` (append orchestrator branch tests)

- [ ] **Step 1: Add HELP text + orchestrator**

```typescript
import { generateRolePlayResponse, generateRolePlayRetry, findScenario } from '@/lib/ai/roleplay-engine'
import { createAgencyRule } from '@/lib/ai/agency-rules'
import { generateSessionSummary } from '@/lib/ai/roleplay-engine'
import type { AIRolePlaySession } from '@/types/database'

export const HELP_TEXT =
  'Training commands:\n' +
  '• TRAIN <pin> — dry-run: you text as a patient, AI replies as coordinator\n' +
  '• ROLEPLAY <pin> [scenario] — you practice as coordinator, AI plays patient\n' +
  '• FIX <note> — redo AI\'s last reply (dry-run)\n' +
  '• SAVE — save AI\'s last reply as a rule (dry-run)\n' +
  '• RULE <text> — save a durable agency rule\n' +
  '• STATUS / DONE'

const AI_TAG = '🤖 '

/**
 * Owns every inbound SMS from an allowlisted trainer number. Returns
 * { handled:false } when `from` is not a trainer (webhook falls through to the
 * normal lead pipeline). When handled, `reply` is the text to send back.
 */
export async function handleTrainerSms(
  supabase: SupabaseClient,
  params: { from: string; body: string }
): Promise<{ handled: boolean; reply: string | null }> {
  const config = await getTrainerConfig(supabase)
  if (!isTrainerNumber(params.from, config.numbers)) {
    return { handled: false, reply: null }
  }

  const phone = normalizeE164(params.from)
  const cmd = parseTrainerCommand(params.body)
  const session = await getActiveSession(supabase, phone)

  // ── No active session ──
  if (!session) {
    if (cmd.kind === 'help' || cmd.kind === 'status') return { handled: true, reply: HELP_TEXT }

    if (cmd.kind === 'train' || cmd.kind === 'roleplay') {
      if (config.pin && cmd.pin !== config.pin) {
        return { handled: true, reply: 'Invalid PIN. Text HELP for commands.' }
      }
      const referenceOrgId = await resolveReferenceOrg(supabase, config.referenceOrgId)
      if (cmd.kind === 'train') {
        await openSession(supabase, {
          trainerPhone: phone, mode: 'dry_run', scenarioKey: null,
          patientPersona: null, referenceOrgId, transcript: [],
        })
        return { handled: true, reply: 'Dry-run started. Text me as a patient — I\'ll reply as the coordinator. DONE to end.' }
      }
      const scenario = findScenario(cmd.scenario || '')
      const opened = await openSession(supabase, {
        trainerPhone: phone, mode: 'roleplay', scenarioKey: scenario.id,
        patientPersona: scenario.patient_persona as unknown as Record<string, unknown>,
        referenceOrgId, transcript: [],
      })
      // AI sends the opening patient line.
      const first = await runRoleplayPatient(supabase, referenceOrgId, opened, scenario)
      await appendTurn(supabase, opened, [{ role: 'assistant', content: first }])
      return { handled: true, reply: `${AI_TAG}[${scenario.name}]\n${first}` }
    }

    if (cmd.kind === 'rule') {
      if (config.pin) return { handled: true, reply: 'Start a session first (TRAIN <pin>) or include your PIN.' }
      if (!cmd.text) return { handled: true, reply: 'Usage: RULE <the guidance to save>' }
      await createAgencyRule(supabase, { text: cmd.text, createdBy: phone })
      return { handled: true, reply: '✓ Saved. Live for all practices on the next message.' }
    }

    return { handled: true, reply: `Not in a training session. ${HELP_TEXT}` }
  }

  // ── Active session ──
  if (cmd.kind === 'done') {
    const summary = await safeSummary(session)
    await endSession(supabase, session.id)
    return { handled: true, reply: `Session ended. ${summary}` }
  }
  if (cmd.kind === 'help') return { handled: true, reply: HELP_TEXT }
  if (cmd.kind === 'status') {
    return { handled: true, reply: `Mode: ${session.mode}${session.scenario_key ? ` (${session.scenario_key})` : ''} · rules saved: ${session.rules_saved}` }
  }
  if (cmd.kind === 'rule') {
    if (!cmd.text) return { handled: true, reply: 'Usage: RULE <the guidance to save>' }
    await createAgencyRule(supabase, { text: cmd.text, createdBy: phone })
    await appendTurn(supabase, session, [], { rules_saved: session.rules_saved + 1 })
    return { handled: true, reply: '✓ Saved. Live for all practices on the next message.' }
  }

  if (session.mode === 'dry_run') return handleDryRunTurn(supabase, session, phone, cmd)
  return handleRoleplayTurn(supabase, session, cmd)
}
```

- [ ] **Step 2: Add the mode-turn helpers + roleplay generators**

```typescript
function toRoleplaySession(
  session: SmsTrainingSession,
  scenarioName: string | null,
  userRole: 'patient' | 'treatment_coordinator'
): Pick<AIRolePlaySession, 'user_role' | 'agent_target' | 'patient_persona' | 'scenario_description' | 'messages'> {
  return {
    user_role: userRole,
    agent_target: 'setter',
    patient_persona: (session.patient_persona as AIRolePlaySession['patient_persona']) ?? null,
    scenario_description: scenarioName,
    messages: session.transcript.map((m) => ({ role: m.role, content: m.content })) as AIRolePlaySession['messages'],
  }
}

/** ROLEPLAY opening: AI = patient. */
async function runRoleplayPatient(
  supabase: SupabaseClient,
  refOrgId: string | null,
  session: SmsTrainingSession,
  scenario: { name: string }
): Promise<string> {
  const rp = toRoleplaySession(session, scenario.name, 'treatment_coordinator')
  return generateRolePlayResponse(supabase, refOrgId || '', rp)
}

/** ROLEPLAY (AI = patient): trainer texts as coordinator, AI answers as patient. */
async function handleRoleplayTurn(
  supabase: SupabaseClient,
  session: SmsTrainingSession,
  cmd: ParsedCommand
): Promise<{ handled: boolean; reply: string | null }> {
  if (cmd.kind !== 'text') return { handled: true, reply: HELP_TEXT }
  const withUser = await appendTurn(supabase, session, [{ role: 'user', content: cmd.text }])
  const rp = toRoleplaySession(withUser, withUser.scenario_key, 'treatment_coordinator')
  const reply = await generateRolePlayResponse(supabase, withUser.reference_org_id || '', rp)
  await appendTurn(supabase, withUser, [{ role: 'assistant', content: reply }])
  return { handled: true, reply: `${AI_TAG}${reply}` }
}

/** DRY-RUN (AI = coordinator): trainer texts as patient, AI answers as TC; FIX/SAVE act on the last AI reply. */
async function handleDryRunTurn(
  supabase: SupabaseClient,
  session: SmsTrainingSession,
  phone: string,
  cmd: ParsedCommand
): Promise<{ handled: boolean; reply: string | null }> {
  const lastAi = [...session.transcript].reverse().find((m) => m.role === 'assistant')?.content || null

  if (cmd.kind === 'save') {
    if (!lastAi) return { handled: true, reply: 'Nothing to save yet — I haven\'t replied.' }
    await createAgencyRule(supabase, { text: lastAi, createdBy: phone })
    await appendTurn(supabase, session, [], { rules_saved: session.rules_saved + 1 })
    return { handled: true, reply: '✓ Saved that reply as a rule. Live for all practices next message.' }
  }

  if (cmd.kind === 'fix') {
    if (!lastAi) return { handled: true, reply: 'No reply to fix yet.' }
    const rp = toRoleplaySession(session, session.scenario_key, 'patient')
    const revised = await generateRolePlayRetry(supabase, session.reference_org_id || '', rp, lastAi, cmd.guidance)
    // Replace the last assistant message in the transcript.
    const idx = session.transcript.map((m) => m.role).lastIndexOf('assistant')
    const nextTranscript = session.transcript.slice()
    if (idx >= 0) nextTranscript[idx] = { role: 'assistant', content: revised }
    await supabase
      .from('sms_training_sessions')
      .update({ transcript: nextTranscript, last_activity_at: new Date().toISOString() })
      .eq('id', session.id)
    return { handled: true, reply: `${AI_TAG}${revised}` }
  }

  if (cmd.kind !== 'text') return { handled: true, reply: HELP_TEXT }
  const withUser = await appendTurn(supabase, session, [{ role: 'user', content: cmd.text }])
  const rp = toRoleplaySession(withUser, withUser.scenario_key, 'patient')
  const reply = await generateRolePlayResponse(supabase, withUser.reference_org_id || '', rp)
  await appendTurn(supabase, withUser, [{ role: 'assistant', content: reply }])
  return { handled: true, reply: `${AI_TAG}${reply}` }
}

async function safeSummary(session: SmsTrainingSession): Promise<string> {
  try {
    return await generateSessionSummary({
      ...(session as unknown as AIRolePlaySession),
      messages: session.transcript.map((m) => ({
        role: m.role, content: m.content, acting_as: m.role === 'user' ? 'treatment_coordinator' : 'patient',
      })) as AIRolePlaySession['messages'],
    } as AIRolePlaySession)
  } catch {
    return `You saved ${session.rules_saved} rule(s).`
  }
}
```

- [ ] **Step 3: Add orchestrator branch tests (stubbed supabase)**

Append to `src/lib/autopilot/__tests__/sms-training.test.ts`:

```typescript
import { handleTrainerSms } from '@/lib/autopilot/sms-training'

// Minimal supabase stub: config query returns allowlist + pin; no active session.
function stubSupabase(overrides: Record<string, unknown> = {}) {
  return {
    from(table: string) {
      if (table === 'agency_settings') {
        return { select: () => ({ in: () => ({ data: [
          { key: 'sms_trainer_numbers', value: ['+14156767420'] },
          { key: 'training_pin', value: '4821' },
        ] }) }) }
      }
      if (table === 'sms_training_sessions') {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => ({ data: null }) }) }) }),
        }
      }
      return { select: () => ({ eq: () => ({ data: [] }) }) }
    },
    ...overrides,
  } as never
}

describe('handleTrainerSms', () => {
  it('ignores non-trainer numbers (falls through)', async () => {
    const r = await handleTrainerSms(stubSupabase(), { from: '+15550001111', body: 'hi' })
    expect(r.handled).toBe(false)
  })
  it('rejects a wrong PIN on TRAIN', async () => {
    const r = await handleTrainerSms(stubSupabase(), { from: '+14156767420', body: 'TRAIN 0000' })
    expect(r.handled).toBe(true)
    expect(r.reply).toContain('Invalid PIN')
  })
  it('HELP works without a session', async () => {
    const r = await handleTrainerSms(stubSupabase(), { from: '+14156767420', body: 'HELP' })
    expect(r.reply).toContain('TRAIN <pin>')
  })
})
```

- [ ] **Step 4: Run tests + type-check**

Run: `npx tsc --noEmit && npx vitest run src/lib/autopilot/__tests__/sms-training.test.ts`
Expected: PASS (parser, phone, and the 3 orchestrator branch tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/autopilot/sms-training.ts src/lib/autopilot/__tests__/sms-training.test.ts
git commit -m "feat(sms-training): handleTrainerSms orchestrator (both modes + rule saves)"
```

---

### Task 10: Wire into the Twilio webhook

**Files:**
- Modify: `src/app/api/webhooks/twilio/route.ts` (insert after `const supabase = createServiceClient()` at line 41, BEFORE the lead lookup at line 43)

- [ ] **Step 1: Insert the training intercept**

After line 41 (`const supabase = createServiceClient()`), insert:

```typescript
  // ── SMS TRAINING CONSOLE ──
  // Allowlisted trainer numbers are owned entirely by the training module and
  // never reach the lead pipeline. This also means a trainer number can't double
  // as a normal test-lead — training always wins (by design).
  const { handleTrainerSms } = await import('@/lib/autopilot/sms-training')
  const training = await handleTrainerSms(supabase, { from, body })
  if (training.handled) {
    const reply = training.reply
      ? `<Message>${training.reply.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</Message>`
      : ''
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response>${reply}</Response>`,
      { headers: { 'Content-Type': 'text/xml' } }
    )
  }
```

- [ ] **Step 2: Type-check + full test suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (whole suite green — per the standing rule that tsc errors, test files included, fail the Vercel build)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/webhooks/twilio/route.ts
git commit -m "feat(sms-training): intercept trainer SMS in Twilio webhook before lead lookup"
```

---

### Task 11: Configure + manual end-to-end verification

**Files:** none (configuration + smoke test)

- [ ] **Step 1: Seed agency settings (staging)**

Insert the three keys (run in Supabase SQL editor / psql against staging):

```sql
insert into public.agency_settings (key, value, description) values
  ('sms_trainer_numbers', '["+14156767420"]'::jsonb, 'Allowlisted SMS training phones'),
  ('training_pin', '"4821"'::jsonb, 'PIN to open an SMS training session'),
  ('training_reference_org', 'null'::jsonb, 'Org id used to give dry-run/roleplay realistic context')
on conflict (key) do update set value = excluded.value;
```

- [ ] **Step 2: Smoke test the flow from the allowlisted phone**

From `+14156767420`, verify each:
1. `HELP` → returns the command list.
2. `TRAIN 4821` → "Dry-run started…". Then text a patient line (e.g. "how much is all on 4?") → AI replies as coordinator, tagged 🤖.
3. `FIX be warmer` → AI re-answers, tagged 🤖.
4. `SAVE` → "✓ Saved that reply as a rule…".
5. `RULE always confirm the consult by phone` → "✓ Saved…".
6. `DONE` → "Session ended…" summary.
7. `ROLEPLAY 4821 cost objection` → opens with a 🤖 patient line for the "Cost Objection Handling" scenario.
8. Wrong PIN `TRAIN 0000` → "Invalid PIN".

- [ ] **Step 3: Confirm rules reach live agents**

Query staging: `select title, content from public.agency_ai_rules order by created_at desc limit 5;` — the saved rules appear. Then trigger a normal inbound SMS from a real test lead and confirm (via server logs / the message) the live agent's behavior reflects the new rule. (Rules are injected via `buildAgencyRulesBlock` at `setter-agent.ts:392` / `closer-agent.ts:591`.)

- [ ] **Step 4: Commit the plan checkboxes (progress)**

```bash
git add docs/superpowers/plans/2026-07-01-sms-training-console.md
git commit -m "docs(sms-training): mark implementation plan complete"
```

---

## Self-review notes

- **Spec coverage:** §3 command grammar → Tasks 5/9; §4 state machine → Task 9; §5 modes/ephemeral (refined: no `routeToAgent`, no tool side effects) → Tasks 7/9; §6 data model + injection → Tasks 1/2/3/4; §7 allowlist+PIN → Tasks 6/9; §8 edge cases → Task 9 branches; §9 testing → Tasks 3/5/9/10.
- **Deviation from spec §5 (documented):** dry-run reuses the roleplay TC generator (extended with agency rules/persona) instead of the live `routeToAgent`, to avoid firing booking/financing tools against a non-existent lead. Still fully ephemeral (no DB lead). Full live-tool parity is a deliberate future enhancement.
- **Type consistency:** `ParsedCommand`, `SmsTrainingSession`, `AgencyAiRule`, `findScenario`, `buildAgencyRulesBlock`, `handleTrainerSms` names are used identically across tasks.
- **Non-goals honored:** no intent classifier, no `ai_training_examples` wiring, no per-practice targeting, no multi-role RBAC.
