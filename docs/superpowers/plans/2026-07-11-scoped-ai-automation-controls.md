# Scoped AI Automation Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins set the AI-vs-human posture per pipeline stage and per campaign — separate inbound/outbound ownership plus min-confidence and active-hours knobs — on top of the existing `automation_policies` engine, surfaced as a stage grid in the AI Control page.

**Architecture:** Reuse `automation_policies` + `resolveAllocation` (already resolves ownership scoped campaign > stage > segment > org). Add three nullable knob columns and return them from the resolver (NULL inherits the org default). Apply the resolved knobs to the autopilot config before the confidence/hours checks in the inbound and outbound decision points. Add an admin-gated CRUD API and a stage-grid UI.

**Tech Stack:** Next.js (App Router), TypeScript, Supabase (Postgres + RLS), Zod, Vitest, React, Tailwind/shadcn.

**Design spec:** `docs/superpowers/specs/2026-07-11-scoped-ai-automation-controls-design.md`

**Worktree:** Implement in an isolated worktree off `origin/main` (superpowers:using-git-worktrees) — the shared checkout is edited by other sessions.

---

## File structure

- Modify `supabase/migrations/` — new migration adding 3 columns to `automation_policies`.
- Modify `src/types/database.ts` — add the 3 fields to `AutomationPolicy`.
- Modify `src/lib/automation/allocation.ts` — add knob fields to `AllocationDecision`, return them from `resolveAllocation`.
- Modify `src/lib/automation/__tests__/allocation.test.ts` — cover knob resolution.
- Modify `src/lib/autopilot/auto-respond.ts` — apply resolved knobs (inbound).
- Modify `src/lib/autopilot/speed-to-lead.ts` — apply resolved knobs (outbound).
- Create `src/lib/automation/scoped-config.ts` — pure helper merging resolved knobs onto an `AutopilotConfig` (DRY across both decision points).
- Create `src/lib/automation/__tests__/scoped-config.test.ts`.
- Create `src/lib/validators/automation-policy.ts` — Zod schema for the CRUD API.
- Create `src/app/api/automation/policies/route.ts` — GET/POST/PATCH/DELETE.
- Create `src/app/api/automation/policies/__tests__/route.test.ts`.
- Create `src/components/crm/scoped-automation-grid.tsx` — the stage/campaign grid.
- Modify `src/components/crm/ai-control-center.tsx` — render the grid in the Controls tab.
- Modify `src/app/(dashboard)/settings/ai/page.tsx` — fetch stages, campaigns, policies; pass to the control center.

---

## Task 1: Migration — knob columns on automation_policies

**Files:**
- Create: `supabase/migrations/20260712_automation_policy_knobs.sql`
- Modify: `src/types/database.ts:2228` (the `AutomationPolicy` type)

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260712_automation_policy_knobs.sql
-- Per-scope autopilot knobs. NULL = inherit the org-level autopilot default.
alter table public.automation_policies
  add column if not exists confidence_threshold numeric(3,2)
    check (confidence_threshold is null or (confidence_threshold >= 0 and confidence_threshold <= 1)),
  add column if not exists active_hours_start smallint
    check (active_hours_start is null or (active_hours_start >= 0 and active_hours_start <= 23)),
  add column if not exists active_hours_end smallint
    check (active_hours_end is null or (active_hours_end >= 1 and active_hours_end <= 24));

comment on column public.automation_policies.confidence_threshold is
  'Per-scope min AI confidence; NULL inherits organizations.autopilot_confidence_threshold.';
comment on column public.automation_policies.active_hours_start is
  'Per-scope active-hours start (0-23); NULL inherits org autopilot_active_hours_start.';
comment on column public.automation_policies.active_hours_end is
  'Per-scope active-hours end (1-24); NULL inherits org autopilot_active_hours_end.';
```

- [ ] **Step 2: Apply the migration to the linked project**

Run: `supabase db query --linked -f supabase/migrations/20260712_automation_policy_knobs.sql`
Expected: `ALTER TABLE` success, no error. (RLS is unchanged — policies inherit the table's existing org-scoped RLS.)

- [ ] **Step 3: Verify the columns exist**

Run:
```bash
supabase db query --linked --query "select column_name from information_schema.columns where table_name='automation_policies' and column_name in ('confidence_threshold','active_hours_start','active_hours_end') order by 1;"
```
Expected: three rows — `active_hours_end`, `active_hours_start`, `confidence_threshold`.

- [ ] **Step 4: Extend the AutomationPolicy type**

In `src/types/database.ts`, inside `export type AutomationPolicy = { ... }`, add after `human_response_sla_seconds: number`:

```typescript
  /** Per-scope min AI confidence (0-1). NULL inherits the org autopilot default. */
  confidence_threshold: number | null
  /** Per-scope active-hours window. NULL inherits the org autopilot default. */
  active_hours_start: number | null
  active_hours_end: number | null
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors from `database.ts`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260712_automation_policy_knobs.sql src/types/database.ts
git commit -m "feat(automation): add per-scope knob columns to automation_policies"
```

---

## Task 2: Return knobs from the allocation resolver

**Files:**
- Modify: `src/lib/automation/allocation.ts`
- Test: `src/lib/automation/__tests__/allocation.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/automation/__tests__/allocation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveAllocation, type AllocationOrgConfig } from '../allocation'
import type { AutomationPolicy } from '@/types/database'

const ORG: AllocationOrgConfig = {
  timezone: 'America/New_York',
  human_first_sla_enabled: false,
  human_first_sla_seconds: 180,
}

function policy(over: Partial<AutomationPolicy>): AutomationPolicy {
  return {
    id: 'p1', organization_id: 'o1', scope: 'stage',
    campaign_id: null, voice_campaign_id: null, stage_id: 's1', smart_list_id: null,
    kinds: [], owner: 'ai', ai_role: null, human_schedule: null,
    human_first: false, human_response_sla_seconds: 180, enabled: true,
    confidence_threshold: null, active_hours_start: null, active_hours_end: null,
    created_at: '', updated_at: '', ...over,
  }
}

describe('resolveAllocation — knob overrides', () => {
  it('returns the matched policy knobs', () => {
    const p = policy({ confidence_threshold: 0.9, active_hours_start: 9, active_hours_end: 17 })
    const d = resolveAllocation([p], ORG, { organizationId: 'o1', kind: 'inbound_reply', stageId: 's1' })
    expect(d.confidenceThreshold).toBe(0.9)
    expect(d.activeHoursStart).toBe(9)
    expect(d.activeHoursEnd).toBe(17)
  })

  it('returns null knobs when unset (caller inherits org default)', () => {
    const p = policy({})
    const d = resolveAllocation([p], ORG, { organizationId: 'o1', kind: 'inbound_reply', stageId: 's1' })
    expect(d.confidenceThreshold).toBeNull()
    expect(d.activeHoursStart).toBeNull()
  })

  it('legacy default carries null knobs', () => {
    const d = resolveAllocation([], ORG, { organizationId: 'o1', kind: 'inbound_reply', stageId: 's1' })
    expect(d.confidenceThreshold).toBeNull()
    expect(d.activeHoursStart).toBeNull()
    expect(d.activeHoursEnd).toBeNull()
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run src/lib/automation/__tests__/allocation.test.ts -t "knob overrides"`
Expected: FAIL — `confidenceThreshold` is `undefined` (property does not exist yet).

- [ ] **Step 3: Add the fields to AllocationDecision and populate them**

In `src/lib/automation/allocation.ts`, extend the type:

```typescript
export type AllocationDecision = {
  owner: 'ai' | 'human' | 'hold'
  reason: string
  policyId: string | null
  slaSeconds: number | null
  aiRole: 'setter' | 'closer' | null
  confidenceThreshold: number | null
  activeHoursStart: number | null
  activeHoursEnd: number | null
}
```

Update `LEGACY_DEFAULT`:

```typescript
const LEGACY_DEFAULT: AllocationDecision = {
  owner: 'ai',
  reason: 'legacy_default',
  policyId: null,
  slaSeconds: null,
  aiRole: null,
  confidenceThreshold: null,
  activeHoursStart: null,
  activeHoursEnd: null,
}
```

In `resolveAllocation`, define the knobs once from the matched policy and spread them into every `return` that carries a policy. Add directly after `const aiRole = policy.ai_role ?? null`:

```typescript
  const knobs = {
    confidenceThreshold: policy.confidence_threshold,
    activeHoursStart: policy.active_hours_start,
    activeHoursEnd: policy.active_hours_end,
  }
```

Then add `...knobs` to each policy-derived return object (the `human_first`, `owner==='human'`, both `hybrid` branches, and the final `policy_ai` return). Also add the three null knob fields to the `org_human_first_sla` return (before `!policy`), matching `LEGACY_DEFAULT`'s null knobs.

- [ ] **Step 4: Run the tests — verify pass**

Run: `npx vitest run src/lib/automation/__tests__/allocation.test.ts`
Expected: PASS (new knob tests + all existing allocation tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/automation/allocation.ts src/lib/automation/__tests__/allocation.test.ts
git commit -m "feat(automation): resolver returns per-scope confidence + active-hours knobs"
```

---

## Task 3: Pure helper — merge resolved knobs onto AutopilotConfig

**Files:**
- Create: `src/lib/automation/scoped-config.ts`
- Test: `src/lib/automation/__tests__/scoped-config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/automation/__tests__/scoped-config.test.ts
import { describe, it, expect } from 'vitest'
import { applyScopedKnobs } from '../scoped-config'
import type { AutopilotConfig } from '@/lib/autopilot/config'
import type { AllocationDecision } from '../allocation'

const base = { confidence_threshold: 0.65, active_hours_start: 8, active_hours_end: 21 } as AutopilotConfig
const dec = (o: Partial<AllocationDecision>): AllocationDecision => ({
  owner: 'ai', reason: 'policy_ai', policyId: 'p', slaSeconds: null, aiRole: null,
  confidenceThreshold: null, activeHoursStart: null, activeHoursEnd: null, ...o,
})

describe('applyScopedKnobs', () => {
  it('overrides confidence + hours when set', () => {
    const c = applyScopedKnobs(base, dec({ confidenceThreshold: 0.9, activeHoursStart: 9, activeHoursEnd: 17 }))
    expect(c.confidence_threshold).toBe(0.9)
    expect(c.active_hours_start).toBe(9)
    expect(c.active_hours_end).toBe(17)
  })

  it('inherits base values when knobs are null', () => {
    const c = applyScopedKnobs(base, dec({}))
    expect(c.confidence_threshold).toBe(0.65)
    expect(c.active_hours_start).toBe(8)
    expect(c.active_hours_end).toBe(21)
  })

  it('does not mutate the base config', () => {
    applyScopedKnobs(base, dec({ confidenceThreshold: 0.9 }))
    expect(base.confidence_threshold).toBe(0.65)
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `npx vitest run src/lib/automation/__tests__/scoped-config.test.ts`
Expected: FAIL — cannot find module `../scoped-config`.

- [ ] **Step 3: Implement the helper**

```typescript
// src/lib/automation/scoped-config.ts
import type { AutopilotConfig } from '@/lib/autopilot/config'
import type { AllocationDecision } from './allocation'

/**
 * Return a copy of `config` with the allocation's per-scope knobs applied.
 * A null knob inherits the org-level value already on `config`. Pure — never
 * mutates the input. Note: an active-hours override clears `config.schedule`
 * so the simpler [start, end) window is used for the scoped decision.
 */
export function applyScopedKnobs(
  config: AutopilotConfig,
  decision: Pick<AllocationDecision, 'confidenceThreshold' | 'activeHoursStart' | 'activeHoursEnd'>
): AutopilotConfig {
  const next: AutopilotConfig = { ...config }
  if (decision.confidenceThreshold != null) next.confidence_threshold = decision.confidenceThreshold
  if (decision.activeHoursStart != null && decision.activeHoursEnd != null) {
    next.active_hours_start = decision.activeHoursStart
    next.active_hours_end = decision.activeHoursEnd
    next.schedule = null
  }
  return next
}
```

- [ ] **Step 4: Run the tests — verify pass**

Run: `npx vitest run src/lib/automation/__tests__/scoped-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/automation/scoped-config.ts src/lib/automation/__tests__/scoped-config.test.ts
git commit -m "feat(automation): applyScopedKnobs merges resolved knobs onto autopilot config"
```

---

## Task 4: Apply scoped knobs at the inbound decision point

**Files:**
- Modify: `src/lib/autopilot/auto-respond.ts` (the allocation block ~lines 130-137 and the `shouldAutoRespond` call ~line 312)

**Context:** `processAutoResponse` already calls `resolveAutomationOwner(...)` into `allocation` and later calls `shouldAutoRespond(config, {...})`. The allocation is currently only used to route non-`ai` owners to a human. We now also apply its knobs to the config used for the confidence/hours gate.

- [ ] **Step 1: Import the helper**

At the top of `src/lib/autopilot/auto-respond.ts`, add:

```typescript
import { applyScopedKnobs } from '@/lib/automation/scoped-config'
```

- [ ] **Step 2: Apply the knobs after the allocation gate**

The existing code resolves `allocation` and, when `allocation.owner !== 'ai'`, returns/holds. Immediately AFTER that block (i.e. once we know the AI owns this reply), replace the config used downstream:

```typescript
  // Scoped knobs: a campaign/stage policy may tighten confidence or hours for
  // this specific reply. Null knobs inherit the org defaults already on config.
  const effectiveConfig = allocation
    ? applyScopedKnobs(config, allocation)
    : config
```

Then change the later `shouldAutoRespond(config, {...})` call to use `effectiveConfig`:

```typescript
  const decision = shouldAutoRespond(effectiveConfig, {
    confidence,
    agentType,
    isFirstMessage,
    currentHour,
  })
```

- [ ] **Step 3: Add a focused integration test**

Add `src/lib/autopilot/__tests__/auto-respond-scoped.test.ts` (mock the supabase client and `resolveAutomationOwner` to return `owner:'ai'` with `confidenceThreshold: 0.9`; assert a reply whose confidence is 0.8 is escalated, not sent). Use the existing `auto-respond` test file as the mocking template if one exists; otherwise assert on the pure path by exporting and testing the `shouldAutoRespond(effectiveConfig, ...)` composition. Minimal pure-path test:

```typescript
import { describe, it, expect } from 'vitest'
import { shouldAutoRespond } from '@/lib/autopilot/config'
import { applyScopedKnobs } from '@/lib/automation/scoped-config'

describe('inbound scoped confidence', () => {
  it('escalates below the per-scope threshold even when above the global one', () => {
    const base = { enabled: true, paused: false, confidence_threshold: 0.65,
      mode: 'full', active_hours_start: 0, active_hours_end: 24, schedule: null,
      timezone: 'America/New_York' } as any
    const cfg = applyScopedKnobs(base, {
      confidenceThreshold: 0.9, activeHoursStart: null, activeHoursEnd: null,
    } as any)
    const r = shouldAutoRespond(cfg, { confidence: 0.8, agentType: 'setter', isFirstMessage: false, currentHour: 12 })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('low_confidence')
  })
})
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/autopilot/__tests__/auto-respond-scoped.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/autopilot/auto-respond.ts src/lib/autopilot/__tests__/auto-respond-scoped.test.ts
git commit -m "feat(autopilot): apply per-scope knobs to inbound auto-response decision"
```

---

## Task 5: Apply scoped knobs at the outbound decision point

**Files:**
- Modify: `src/lib/autopilot/speed-to-lead.ts` (its allocation gate + confidence/hours check)

**Context:** `triggerSpeedToLead` already calls `resolveAutomationOwner({ kind: 'speed_to_lead', ... })` and gates on owner. It then applies the org confidence threshold before sending.

- [ ] **Step 1: Import the helper**

```typescript
import { applyScopedKnobs } from '@/lib/automation/scoped-config'
```

- [ ] **Step 2: Apply knobs once the AI owns the touch**

After the outbound allocation gate (where `owner !== 'ai'` returns/holds), add:

```typescript
  const effectiveConfig = allocation ? applyScopedKnobs(config, allocation) : config
```

Replace the subsequent uses of `config.confidence_threshold` and the active-hours check with `effectiveConfig` (same fields). If the file uses `shouldAutoRespond`, pass `effectiveConfig`; if it inlines a `confidence < config.confidence_threshold` check, change it to `effectiveConfig.confidence_threshold`.

- [ ] **Step 3: Add a pure-path test**

Add `src/lib/autopilot/__tests__/speed-to-lead-scoped.test.ts` asserting `applyScopedKnobs` tightens the outbound confidence the same way (mirror the Task 4 pure test, `agentType: 'setter'`, `isFirstMessage: true`).

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/lib/autopilot/__tests__/speed-to-lead-scoped.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/autopilot/speed-to-lead.ts src/lib/autopilot/__tests__/speed-to-lead-scoped.test.ts
git commit -m "feat(autopilot): apply per-scope knobs to outbound speed-to-lead decision"
```

---

## Task 6: Zod validator for a policy write

**Files:**
- Create: `src/lib/validators/automation-policy.ts`

- [ ] **Step 1: Write the validator**

```typescript
// src/lib/validators/automation-policy.ts
import { z } from 'zod'

export const automationPolicyInput = z.object({
  scope: z.enum(['campaign', 'stage']),
  campaign_id: z.string().uuid().nullable().optional(),
  voice_campaign_id: z.string().uuid().nullable().optional(),
  stage_id: z.string().uuid().nullable().optional(),
  kinds: z.array(z.enum(['inbound_reply', 'speed_to_lead', 'nurture_step'])).min(1),
  owner: z.enum(['ai', 'human', 'hybrid']),
  human_schedule: z.record(z.string(), z.unknown()).nullable().optional(),
  human_first: z.boolean().optional(),
  human_response_sla_seconds: z.number().int().min(30).max(3600).optional(),
  confidence_threshold: z.number().min(0).max(1).nullable().optional(),
  active_hours_start: z.number().int().min(0).max(23).nullable().optional(),
  active_hours_end: z.number().int().min(1).max(24).nullable().optional(),
  enabled: z.boolean().optional(),
}).refine(
  (d) => (d.scope === 'campaign' ? !!(d.campaign_id || d.voice_campaign_id) : !!d.stage_id),
  { message: 'scope target id is required for the chosen scope' }
).refine(
  (d) => d.active_hours_start == null || d.active_hours_end == null || d.active_hours_start < d.active_hours_end,
  { message: 'active_hours_start must be < active_hours_end' }
)

export type AutomationPolicyInput = z.infer<typeof automationPolicyInput>
```

- [ ] **Step 2: Write a validator test**

```typescript
// src/lib/validators/__tests__/automation-policy.test.ts
import { describe, it, expect } from 'vitest'
import { automationPolicyInput } from '../automation-policy'

describe('automationPolicyInput', () => {
  it('accepts a stage rule', () => {
    const r = automationPolicyInput.safeParse({ scope: 'stage', stage_id: '00000000-0000-0000-0000-000000000001', kinds: ['inbound_reply'], owner: 'ai' })
    expect(r.success).toBe(true)
  })
  it('rejects a campaign rule with no target', () => {
    const r = automationPolicyInput.safeParse({ scope: 'campaign', kinds: ['inbound_reply'], owner: 'ai' })
    expect(r.success).toBe(false)
  })
  it('rejects inverted hours', () => {
    const r = automationPolicyInput.safeParse({ scope: 'stage', stage_id: '00000000-0000-0000-0000-000000000001', kinds: ['inbound_reply'], owner: 'ai', active_hours_start: 18, active_hours_end: 9 })
    expect(r.success).toBe(false)
  })
})
```

- [ ] **Step 3: Run — verify pass**

Run: `npx vitest run src/lib/validators/__tests__/automation-policy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 4: Commit**

```bash
git add src/lib/validators/automation-policy.ts src/lib/validators/__tests__/automation-policy.test.ts
git commit -m "feat(automation): zod validator for policy writes"
```

---

## Task 7: CRUD API — /api/automation/policies

**Files:**
- Create: `src/app/api/automation/policies/route.ts`

Mirrors the auth/rate-limit/permission pattern of `src/app/api/autopilot/settings/route.ts`: `applyRateLimit(request, RATE_LIMITS.api)`, `resolveActiveOrg`, and `hasPermission(role, 'ai_control:write')` for mutations (read requires only `ai_control:read`).

- [ ] **Step 1: Write the route**

```typescript
// src/app/api/automation/policies/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { applyRateLimit } from '@/lib/webhooks/verify'
import { RATE_LIMITS } from '@/lib/rate-limit'
import { hasPermission } from '@/lib/auth/permissions'
import { getOwnProfile, resolveActiveOrg } from '@/lib/auth/active-org'
import { automationPolicyInput } from '@/lib/validators/automation-policy'

export async function GET(request: NextRequest) {
  const rl = applyRateLimit(request, RATE_LIMITS.api); if (rl) return rl
  const supabase = await createClient()
  const { data: profile } = await getOwnProfile(supabase, 'organization_id')
  if (!profile) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data, error } = await supabase
    .from('automation_policies').select('*').eq('organization_id', orgId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ policies: data ?? [] })
}

async function requireWriter(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const { data: profile } = await supabase.from('user_profiles').select('role').eq('id', user.id).single()
  if (!profile || !hasPermission(profile.role, 'ai_control:write')) {
    return { error: NextResponse.json({ error: 'AI settings are managed by your agency' }, { status: 403 }) }
  }
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  return { orgId }
}

export async function POST(request: NextRequest) {
  const rl = applyRateLimit(request, RATE_LIMITS.api); if (rl) return rl
  const supabase = await createClient()
  const gate = await requireWriter(supabase); if ('error' in gate) return gate.error
  let body: unknown; try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = automationPolicyInput.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid policy', details: parsed.error.flatten() }, { status: 400 })
  const { data, error } = await supabase
    .from('automation_policies')
    .insert({ ...parsed.data, organization_id: gate.orgId })
    .select('*').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ policy: data }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const rl = applyRateLimit(request, RATE_LIMITS.api); if (rl) return rl
  const supabase = await createClient()
  const gate = await requireWriter(supabase); if ('error' in gate) return gate.error
  let body: unknown; try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const { id, ...rest } = (body ?? {}) as { id?: string }
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const parsed = automationPolicyInput.partial().safeParse(rest)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid policy', details: parsed.error.flatten() }, { status: 400 })
  const { data, error } = await supabase
    .from('automation_policies').update(parsed.data)
    .eq('id', id).eq('organization_id', gate.orgId)
    .select('*').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ policy: data })
}

export async function DELETE(request: NextRequest) {
  const rl = applyRateLimit(request, RATE_LIMITS.api); if (rl) return rl
  const supabase = await createClient()
  const gate = await requireWriter(supabase); if ('error' in gate) return gate.error
  const id = new URL(request.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })
  const { error } = await supabase.from('automation_policies').delete().eq('id', id).eq('organization_id', gate.orgId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Typecheck + build the route**

Run: `npx tsc --noEmit`
Expected: no errors. (Route is exercised end-to-end in Task 8's UI; a full route unit test requires the project's supabase mock harness — if one exists under `src/app/api/**/__tests__`, add a POST-validation-rejection test mirroring it.)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/automation/policies/route.ts
git commit -m "feat(api): CRUD for automation_policies (admin-gated, org-scoped)"
```

---

## Task 8: Stage-grid UI + page wiring

**Files:**
- Create: `src/components/crm/scoped-automation-grid.tsx`
- Modify: `src/components/crm/ai-control-center.tsx` (render the grid in the Controls tab)
- Modify: `src/app/(dashboard)/settings/ai/page.tsx` (fetch stages, campaigns, policies; pass down)

- [ ] **Step 1: Fetch data in the page**

In `src/app/(dashboard)/settings/ai/page.tsx`, after the existing fetches and before the `return`, add:

```typescript
  const [{ data: stages }, { data: campaigns }, { data: policies }] = await Promise.all([
    supabase.from('pipeline_stages').select('id, name, position').eq('organization_id', orgId).order('position', { ascending: true }),
    supabase.from('campaigns').select('id, name, status').eq('organization_id', orgId).in('status', ['active', 'paused', 'draft']).order('name'),
    supabase.from('automation_policies').select('*').eq('organization_id', orgId),
  ])
```

Pass them into the component:

```tsx
    <AIControlCenter
      settings={org || {}}
      conversations={aiConversations || []}
      recentActivities={recentActivities || []}
      pendingEscalations={pendingEscalations || 0}
      isAdmin={role === 'admin' || role === 'owner'}
      stages={stages || []}
      campaigns={campaigns || []}
      policies={policies || []}
    />
```

- [ ] **Step 2: Extend the AIControlCenter props and render the grid**

In `src/components/crm/ai-control-center.tsx`, extend `AIControlCenterProps` with:

```typescript
  stages: { id: string; name: string; position: number }[]
  campaigns: { id: string; name: string; status: string }[]
  policies: import('@/types/database').AutomationPolicy[]
```

Import the grid and render it inside the Controls tab, below the existing global control cards:

```tsx
import { ScopedAutomationGrid } from './scoped-automation-grid'
// ...inside the Controls tab content, after the existing cards:
<ScopedAutomationGrid
  stages={stages}
  campaigns={campaigns}
  policies={policies}
  globalDefaults={{
    confidence_threshold: settings.autopilot_confidence_threshold ?? 0.75,
    active_hours_start: settings.autopilot_active_hours_start ?? 8,
    active_hours_end: settings.autopilot_active_hours_end ?? 21,
  }}
  isAdmin={isAdmin}
/>
```

- [ ] **Step 3: Implement the grid component**

```tsx
// src/components/crm/scoped-automation-grid.tsx
'use client'
import { useState } from 'react'
import type { AutomationPolicy } from '@/types/database'

type Owner = 'ai' | 'human' | 'hybrid'
type Row = { id: string; name: string }
type Defaults = { confidence_threshold: number; active_hours_start: number; active_hours_end: number }

const INBOUND = ['inbound_reply']
const OUTBOUND = ['speed_to_lead', 'nurture_step']

function findPolicy(policies: AutomationPolicy[], scope: 'stage' | 'campaign', targetId: string, dir: 'in' | 'out') {
  const kind = dir === 'in' ? 'inbound_reply' : 'speed_to_lead'
  return policies.find(p =>
    p.scope === scope &&
    (scope === 'stage' ? p.stage_id === targetId : p.campaign_id === targetId) &&
    (p.kinds.length === 0 || p.kinds.includes(kind)))
}

export function ScopedAutomationGrid({
  stages, campaigns, policies: initial, globalDefaults, isAdmin,
}: {
  stages: Row[]; campaigns: Row[]; policies: AutomationPolicy[]; globalDefaults: Defaults; isAdmin: boolean
}) {
  const [policies, setPolicies] = useState(initial)

  async function upsert(scope: 'stage' | 'campaign', targetId: string, dir: 'in' | 'out', owner: Owner) {
    const kinds = dir === 'in' ? INBOUND : OUTBOUND
    const existing = findPolicy(policies, scope, targetId, dir)
    const payload = {
      scope, kinds, owner,
      stage_id: scope === 'stage' ? targetId : null,
      campaign_id: scope === 'campaign' ? targetId : null,
      ...(existing ? { id: existing.id } : {}),
    }
    const res = await fetch('/api/automation/policies', {
      method: existing ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) return
    const { policy } = await res.json()
    setPolicies(prev => existing ? prev.map(p => p.id === policy.id ? policy : p) : [...prev, policy])
  }

  function ownerCell(scope: 'stage' | 'campaign', targetId: string, dir: 'in' | 'out') {
    const p = findPolicy(policies, scope, targetId, dir)
    const value = p?.owner ?? ''
    return (
      <select
        aria-label={`${dir === 'in' ? 'inbound' : 'outbound'} owner`}
        disabled={!isAdmin}
        value={value}
        onChange={e => upsert(scope, targetId, dir, e.target.value as Owner)}
        className="w-full bg-transparent text-sm"
      >
        <option value="">— global (AI)</option>
        <option value="ai">AI</option>
        <option value="human">Human</option>
        <option value="hybrid">Hybrid</option>
      </select>
    )
  }

  const section = (label: string, rows: Row[], scope: 'stage' | 'campaign') => (
    <div className="mb-6">
      <h3 className="text-sm font-medium mb-2">{label}</h3>
      <div className="rounded-xl border border-border/60 overflow-hidden">
        <div className="grid grid-cols-[1.6fr_1fr_1fr] gap-2 px-3 py-2 text-xs text-muted-foreground border-b border-border/60">
          <span>{scope === 'stage' ? 'Stage' : 'Campaign'}</span><span>Inbound</span><span>Outbound</span>
        </div>
        {rows.map(r => (
          <div key={r.id} className="grid grid-cols-[1.6fr_1fr_1fr] gap-2 px-3 py-2 items-center border-b border-border/40 last:border-0">
            <span className="text-sm">{r.name}</span>
            {ownerCell(scope, r.id, 'in')}
            {ownerCell(scope, r.id, 'out')}
          </div>
        ))}
        {rows.length === 0 && <div className="px-3 py-4 text-sm text-muted-foreground">Nothing to configure yet.</div>}
      </div>
    </div>
  )

  return (
    <div className="mt-8">
      <h2 className="text-base font-medium mb-1">Scoped automation</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Override who handles each stage or campaign. Cells left on “global” inherit the settings above
        (confidence {globalDefaults.confidence_threshold}, hours {globalDefaults.active_hours_start}:00–{globalDefaults.active_hours_end}:00).
      </p>
      {section('By stage', stages, 'stage')}
      {section('By campaign', campaigns, 'campaign')}
    </div>
  )
}
```

> Note: this first cut ships the two owner columns (inbound/outbound). The confidence + active-hours popover editors reuse the same `upsert` path with the knob fields added to the payload — add them as a follow-up step once the owner grid is verified in the browser, to keep this task reviewable.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: compiles; `/settings/ai` in the build output.

- [ ] **Step 5: Verify in the browser (preview)**

Start the dev server, open `/settings/ai`, confirm: the "Scoped automation" section renders a By-stage grid and a By-campaign grid; changing a stage's Inbound select to "Human" POSTs to `/api/automation/policies` (201) and the cell persists on reload. Confirm a non-admin sees disabled selects.

- [ ] **Step 6: Commit**

```bash
git add src/components/crm/scoped-automation-grid.tsx src/components/crm/ai-control-center.tsx "src/app/(dashboard)/settings/ai/page.tsx"
git commit -m "feat(ui): scoped automation stage/campaign grid in AI Control"
```

---

## Task 9: End-to-end verification + PR

- [ ] **Step 1: Full test + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 2: Manual acceptance (browser)**

- Set the Nurturing stage Inbound = Human → an inbound reply from a Nurturing-stage lead creates a human task and is NOT auto-sent.
- Set a stage Inbound = AI and add a 0.9 confidence knob → a 0.8-confidence draft escalates instead of sending.
- Global kill switch still halts everything regardless of any rule.
- The test-account (`ai_autopilot_override='force_on'`) still behaves per the per-lead override (rules do not override it).

- [ ] **Step 3: Open PR to main**

```bash
git push -u origin HEAD
gh pr create --base main --title "Scoped AI automation controls (per-stage / per-campaign)" --body "Implements docs/superpowers/specs/2026-07-11-scoped-ai-automation-controls-design.md. Stage/campaign grid over the existing automation_policies engine + per-scope confidence/hours knobs.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Do NOT deploy from the shared working tree — let this land via PR and be deployed deliberately.
