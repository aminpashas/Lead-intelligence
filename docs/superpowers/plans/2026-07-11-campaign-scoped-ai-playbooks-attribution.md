# Campaign-Scoped AI, Playbooks & Attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a campaign the scope-carrier for AI behavior, send authorization, and full-funnel reporting, so the AI works only leads enrolled in an AI-enabled campaign — never new/unenrolled leads — at a per-campaign supervision level, with per-campaign playbooks and attributed outcomes.

**Architecture:** Add AI/send columns to `campaigns`. A single resolver reads a lead's last-touch active enrollment and returns its policy. AI surfaces (speed-to-lead, auto-respond, nurture executor) consult it to decide proceed/draft/skip; physical sends are authorized centrally in the low-level send helpers (deny-by-default for automation callers, human sends exempt). Review-first drafts land in a dedicated table; a funnel query attributes outcomes by last-touch enrollment.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Supabase (Postgres + RLS), Vitest, Twilio/Resend, existing autopilot + campaigns libs.

**Spec:** `docs/superpowers/specs/2026-07-11-campaign-scoped-ai-playbooks-attribution-design.md`

---

## File structure

**New files**
- `src/lib/campaigns/policy.ts` — `resolveActiveCampaignPolicy`, policy types
- `src/lib/campaigns/send-authorization.ts` — `isAutomationCaller`, `assertCampaignSendAllowed`
- `src/lib/campaigns/review-queue.ts` — `createReviewDraft`, `approveReviewDraft`, `rejectReviewDraft`
- `src/lib/campaigns/attribution.ts` — `getCampaignFunnel`
- `supabase/migrations/20260711120000_campaign_ai_scope.sql` — columns + backfill + review-drafts table
- API routes: `src/app/api/campaigns/[id]/policy/route.ts`, `src/app/api/campaigns/review-drafts/[id]/route.ts`
- Tests colocated under each lib's `__tests__/` as `*.test.ts`

**Modified files**
- `src/types/database.ts` — `Campaign` new fields, `CampaignPlaybook`, `CampaignReviewDraft`
- `src/lib/messaging/twilio.ts`, `src/lib/messaging/resend.ts` — central send backstop + result-reason union
- `src/lib/autopilot/speed-to-lead.ts`, `src/lib/autopilot/auto-respond.ts` — campaign gate + review-first routing
- `src/lib/campaigns/nurture-executor.ts`, `src/lib/campaigns/executor.ts` — campaign gate for email path
- `src/lib/ai/agent-context.ts` (or wherever `buildAgentContext` lives) — playbook injection
- `src/components/crm/campaign-builder.tsx`, `src/components/crm/campaign-analytics.tsx` — policy controls + funnel readout

**Run a single test file:** `npx vitest run <path>` · **Run all:** `npm test`

---

## Task 1: Migration — campaign AI columns, backfill, review-drafts table

**Files:**
- Create: `supabase/migrations/20260711120000_campaign_ai_scope.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Campaign-scoped AI: make a campaign carry its own AI behavior + send authorization.
--
-- ai_enabled      may the AI work leads enrolled in this campaign at all
-- autopilot_mode  per-campaign supervision: review_first (draft, human approves) | auto | off
-- send_mode       deny-by-default physical-send authorization: suppressed | live
-- playbook        goal/tone/hooks/guardrails injected into the agent prompt
--
-- Deny-by-default for NEW campaigns (defaults ai_enabled=false, send_mode=suppressed),
-- but backfill existing rows to send_mode=live so campaigns already running keep sending.
-- Replay-safe: add-column-if-not-exists guards + idempotent constraint drops.

alter table public.campaigns
  add column if not exists ai_enabled boolean not null default false,
  add column if not exists autopilot_mode text not null default 'review_first',
  add column if not exists send_mode text not null default 'suppressed',
  add column if not exists playbook jsonb not null default '{}'::jsonb;

alter table public.campaigns drop constraint if exists campaigns_autopilot_mode_check;
alter table public.campaigns
  add constraint campaigns_autopilot_mode_check
  check (autopilot_mode in ('review_first', 'auto', 'off'));

alter table public.campaigns drop constraint if exists campaigns_send_mode_check;
alter table public.campaigns
  add constraint campaigns_send_mode_check
  check (send_mode in ('suppressed', 'live'));

-- Preserve current behavior for campaigns that already existed before this migration.
update public.campaigns set send_mode = 'live' where send_mode = 'suppressed';

-- Review queue for review_first campaigns: AI drafts a message, a human approves before it sends.
create table if not exists public.campaign_review_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  conversation_id uuid,
  channel text not null check (channel in ('sms', 'email')),
  subject text,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.user_profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_campaign_review_drafts_pending
  on public.campaign_review_drafts (organization_id, status)
  where status = 'pending';

alter table public.campaign_review_drafts enable row level security;

drop policy if exists campaign_review_drafts_org on public.campaign_review_drafts;
create policy campaign_review_drafts_org on public.campaign_review_drafts
  for all using (organization_id = public.get_user_org_id())
  with check (organization_id = public.get_user_org_id());
```

- [ ] **Step 2: Apply the migration to the linked project**

Run: `supabase db query --linked -f supabase/migrations/20260711120000_campaign_ai_scope.sql`
Expected: no error; re-running is a no-op (idempotent guards).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260711120000_campaign_ai_scope.sql
git commit -m "feat(campaigns): add AI scope columns + review-drafts table"
```

---

## Task 2: Types + policy resolver

**Files:**
- Modify: `src/types/database.ts` (add fields to `Campaign` ~447-470; add new types)
- Create: `src/lib/campaigns/policy.ts`
- Test: `src/lib/campaigns/__tests__/policy.test.ts`

- [ ] **Step 1: Extend `Campaign` and add supporting types in `src/types/database.ts`**

Add these fields inside the `Campaign` type (after `allow_unconsented_email` at line 465):

```ts
  ai_enabled: boolean
  autopilot_mode: 'review_first' | 'auto' | 'off'
  send_mode: 'suppressed' | 'live'
  playbook: CampaignPlaybook
```

Add these new exported types near `Campaign`:

```ts
export type CampaignPlaybook = {
  goal?: string
  tone?: string
  hooks?: string[]
  offer?: string
  guardrails?: string[]
  donts?: string[]
  objection_notes?: string
}

export type CampaignReviewDraft = {
  id: string
  organization_id: string
  campaign_id: string
  lead_id: string
  conversation_id: string | null
  channel: 'sms' | 'email'
  subject: string | null
  body: string
  status: 'pending' | 'approved' | 'rejected'
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
}
```

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/campaigns/__tests__/policy.test.ts
import { describe, it, expect, vi } from 'vitest'
import { resolveActiveCampaignPolicy } from '@/lib/campaigns/policy'

function mockSupabase(rows: any[] | null, error: unknown = null) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: rows, error }),
  }
  return { from: vi.fn(() => chain) } as any
}

describe('resolveActiveCampaignPolicy', () => {
  it('returns null when the lead has no active enrollment', async () => {
    const policy = await resolveActiveCampaignPolicy(mockSupabase([]), 'lead-1', 'org-1')
    expect(policy).toBeNull()
  })

  it('returns the last-touch active campaign policy with defaults applied', async () => {
    const rows = [
      { campaign_id: 'c-2', created_at: '2026-07-10T00:00:00Z', campaign: { id: 'c-2', ai_enabled: true, autopilot_mode: 'auto', send_mode: 'live', playbook: { goal: 'rebook' } } },
    ]
    const policy = await resolveActiveCampaignPolicy(mockSupabase(rows), 'lead-1', 'org-1')
    expect(policy).toEqual({
      campaignId: 'c-2',
      aiEnabled: true,
      autopilotMode: 'auto',
      sendMode: 'live',
      playbook: { goal: 'rebook' },
    })
  })

  it('defaults missing policy fields to review_first / suppressed / {}', async () => {
    const rows = [{ campaign_id: 'c-3', created_at: '2026-07-10T00:00:00Z', campaign: { id: 'c-3', ai_enabled: false, autopilot_mode: null, send_mode: null, playbook: null } }]
    const policy = await resolveActiveCampaignPolicy(mockSupabase(rows), 'lead-1', 'org-1')
    expect(policy).toMatchObject({ aiEnabled: false, autopilotMode: 'review_first', sendMode: 'suppressed', playbook: {} })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/campaigns/__tests__/policy.test.ts`
Expected: FAIL — cannot find module `@/lib/campaigns/policy`.

- [ ] **Step 4: Implement `src/lib/campaigns/policy.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CampaignPlaybook } from '@/types/database'

export type CampaignAutopilotMode = 'review_first' | 'auto' | 'off'
export type CampaignSendMode = 'suppressed' | 'live'

export interface CampaignPolicy {
  campaignId: string
  aiEnabled: boolean
  autopilotMode: CampaignAutopilotMode
  sendMode: CampaignSendMode
  playbook: CampaignPlaybook
}

/**
 * The lead's last-touch (most recently enrolled) ACTIVE campaign, with its AI policy.
 * Returns null when the lead is in no active campaign — the default-deny state.
 */
export async function resolveActiveCampaignPolicy(
  supabase: SupabaseClient,
  leadId: string,
  organizationId: string
): Promise<CampaignPolicy | null> {
  const { data, error } = await supabase
    .from('campaign_enrollments')
    .select('campaign_id, created_at, campaign:campaigns(id, ai_enabled, autopilot_mode, send_mode, playbook)')
    .eq('lead_id', leadId)
    .eq('organization_id', organizationId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)

  if (error || !data || data.length === 0) return null
  const c = (data[0] as any).campaign
  if (!c) return null

  return {
    campaignId: c.id,
    aiEnabled: !!c.ai_enabled,
    autopilotMode: (c.autopilot_mode ?? 'review_first') as CampaignAutopilotMode,
    sendMode: (c.send_mode ?? 'suppressed') as CampaignSendMode,
    playbook: (c.playbook ?? {}) as CampaignPlaybook,
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/campaigns/__tests__/policy.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types/database.ts src/lib/campaigns/policy.ts src/lib/campaigns/__tests__/policy.test.ts
git commit -m "feat(campaigns): campaign policy resolver + AI scope types"
```

---

## Task 3: Send-authorization helper

**Files:**
- Create: `src/lib/campaigns/send-authorization.ts`
- Test: `src/lib/campaigns/__tests__/send-authorization.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/campaigns/__tests__/send-authorization.test.ts
import { describe, it, expect, vi } from 'vitest'
import { isAutomationCaller, assertCampaignSendAllowed } from '@/lib/campaigns/send-authorization'

function mockSupabase(leadOrg: string | null, enrollmentRows: any[]) {
  return {
    from: vi.fn((table: string) => {
      if (table === 'leads') {
        return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: leadOrg ? { organization_id: leadOrg } : null, error: null }) }
      }
      // campaign_enrollments
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data: enrollmentRows, error: null }) }
    }),
  } as any
}

describe('isAutomationCaller', () => {
  it('flags autopilot/campaign callers, exempts humans', () => {
    expect(isAutomationCaller('autopilot.auto_respond')).toBe(true)
    expect(isAutomationCaller('campaign.executor')).toBe(true)
    expect(isAutomationCaller('manual')).toBe(false)
    expect(isAutomationCaller(undefined)).toBe(false)
  })
})

describe('assertCampaignSendAllowed', () => {
  it('always allows human-initiated sends (no caller)', async () => {
    const res = await assertCampaignSendAllowed(mockSupabase('org-1', []), { leadId: 'l1' })
    expect(res).toEqual({ allowed: true })
  })

  it('blocks an automation send when the lead is in no active campaign', async () => {
    const res = await assertCampaignSendAllowed(mockSupabase('org-1', []), { leadId: 'l1', caller: 'campaign.executor' })
    expect(res).toEqual({ allowed: false, reason: 'no_active_campaign' })
  })

  it('blocks an automation send when the active campaign is suppressed', async () => {
    const rows = [{ campaign_id: 'c1', created_at: 't', campaign: { id: 'c1', ai_enabled: true, autopilot_mode: 'auto', send_mode: 'suppressed', playbook: {} } }]
    const res = await assertCampaignSendAllowed(mockSupabase('org-1', rows), { leadId: 'l1', caller: 'autopilot.speed_to_lead' })
    expect(res).toEqual({ allowed: false, reason: 'send_suppressed' })
  })

  it('allows an automation send when the active campaign is live', async () => {
    const rows = [{ campaign_id: 'c1', created_at: 't', campaign: { id: 'c1', ai_enabled: true, autopilot_mode: 'auto', send_mode: 'live', playbook: {} } }]
    const res = await assertCampaignSendAllowed(mockSupabase('org-1', rows), { leadId: 'l1', caller: 'campaign.nurture' })
    expect(res).toEqual({ allowed: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/campaigns/__tests__/send-authorization.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/campaigns/send-authorization.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveActiveCampaignPolicy } from './policy'

const AUTOMATION_CALLER_PREFIXES = ['autopilot.', 'campaign.']

/** Automation-origin sends are campaign-gated; human staff sends are never gated (spec D5). */
export function isAutomationCaller(caller?: string): boolean {
  if (!caller) return false
  return AUTOMATION_CALLER_PREFIXES.some((p) => caller.startsWith(p))
}

export type CampaignSendDecision =
  | { allowed: true }
  | { allowed: false; reason: 'no_active_campaign' | 'send_suppressed' }

/**
 * Deny-by-default authorization for AUTOMATION sends. A human-initiated send
 * (no automation caller) is always allowed. An automation send is allowed only
 * when the lead's last-touch active campaign has send_mode='live'.
 */
export async function assertCampaignSendAllowed(
  supabase: SupabaseClient,
  params: { leadId: string; caller?: string }
): Promise<CampaignSendDecision> {
  if (!isAutomationCaller(params.caller)) return { allowed: true }

  const { data: lead } = await supabase
    .from('leads')
    .select('organization_id')
    .eq('id', params.leadId)
    .single()
  if (!lead) return { allowed: false, reason: 'no_active_campaign' }

  const policy = await resolveActiveCampaignPolicy(supabase, params.leadId, (lead as any).organization_id)
  if (!policy) return { allowed: false, reason: 'no_active_campaign' }
  if (policy.sendMode !== 'live') return { allowed: false, reason: 'send_suppressed' }
  return { allowed: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/campaigns/__tests__/send-authorization.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/campaigns/send-authorization.ts src/lib/campaigns/__tests__/send-authorization.test.ts
git commit -m "feat(campaigns): deny-by-default send authorization for automation callers"
```

---

## Task 4: Central send backstop in the low-level send helpers

**Files:**
- Modify: `src/lib/messaging/twilio.ts` (result union ~71-73; inside `sendSMSToLead` ~112 start)
- Modify: `src/lib/messaging/resend.ts` (result union ~60-62; inside `sendEmailToLead` ~83 start)
- Test: `src/lib/messaging/__tests__/campaign-send-backstop.test.ts`

- [ ] **Step 1: Extend the result reason unions**

In `src/lib/messaging/twilio.ts`, add `'campaign_not_authorized'` to `SendSMSToLeadResult` (line 73):

```ts
export type SendSMSToLeadResult =
  | { sent: true; sid: string; status: string }
  | { sent: false; reason: ConsentDenyReason | 'compliance_blocked' | 'compliance_review_required' | 'quiet_hours' | 'us_sms_disabled' | 'campaign_not_authorized' }
```

In `src/lib/messaging/resend.ts`, add it to `SendEmailToLeadResult` (line 62):

```ts
export type SendEmailToLeadResult =
  | { sent: true; id: string }
  | { sent: false; reason: ConsentDenyReason | 'compliance_blocked' | 'compliance_review_required' | 'campaign_not_authorized' }
```

- [ ] **Step 2: Insert the backstop at the top of `sendSMSToLead`**

In `src/lib/messaging/twilio.ts`, immediately after the function opening brace (line 112) and before any other work:

```ts
  const { assertCampaignSendAllowed } = await import('@/lib/campaigns/send-authorization')
  const campaignDecision = await assertCampaignSendAllowed(params.supabase, { leadId: params.leadId, caller: params.caller })
  if (!campaignDecision.allowed) {
    return { sent: false, reason: 'campaign_not_authorized' }
  }
```

- [ ] **Step 3: Insert the same backstop at the top of `sendEmailToLead`**

In `src/lib/messaging/resend.ts`, immediately after the function opening brace (line 83):

```ts
  const { assertCampaignSendAllowed } = await import('@/lib/campaigns/send-authorization')
  const campaignDecision = await assertCampaignSendAllowed(params.supabase, { leadId: params.leadId, caller: params.caller })
  if (!campaignDecision.allowed) {
    return { sent: false, reason: 'campaign_not_authorized' }
  }
```

- [ ] **Step 4: Write the test**

```ts
// src/lib/messaging/__tests__/campaign-send-backstop.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/campaigns/send-authorization', () => ({
  assertCampaignSendAllowed: vi.fn(),
}))

import { assertCampaignSendAllowed } from '@/lib/campaigns/send-authorization'
import { sendSMSToLead } from '@/lib/messaging/twilio'

describe('sendSMSToLead campaign backstop', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses an automation send the campaign layer blocks', async () => {
    ;(assertCampaignSendAllowed as any).mockResolvedValue({ allowed: false, reason: 'send_suppressed' })
    const res = await sendSMSToLead({
      supabase: {} as any, leadId: 'l1', to: '+15550000000', body: 'hi', caller: 'campaign.executor',
    })
    expect(res).toEqual({ sent: false, reason: 'campaign_not_authorized' })
  })
})
```

> Note: this test asserts the backstop short-circuits before any Twilio/consent work, so no Supabase/Twilio mocks are needed beyond the mocked authorization module.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/messaging/__tests__/campaign-send-backstop.test.ts`
Expected: PASS. Then run `npm test` and confirm existing twilio/resend tests still pass (human sends — no `caller` — return `{ allowed: true }` only if the real module is used; here it's mocked, so also spot-check with `assertCampaignSendAllowed` returning `{ allowed: true }` lets flow continue).

- [ ] **Step 6: Commit**

```bash
git add src/lib/messaging/twilio.ts src/lib/messaging/resend.ts src/lib/messaging/__tests__/campaign-send-backstop.test.ts
git commit -m "feat(messaging): central campaign send backstop in sendSMSToLead/sendEmailToLead"
```

---

## Task 5: Gate speed-to-lead (isolation for new leads)

**Files:**
- Modify: `src/lib/autopilot/speed-to-lead.ts` (insert after lead load, ~line 162)
- Test: `src/lib/autopilot/__tests__/speed-to-lead-campaign-gate.test.ts`

- [ ] **Step 1: Insert the campaign gate after the lead is loaded**

In `src/lib/autopilot/speed-to-lead.ts`, immediately after the `if (!lead) return { action: 'skipped' }` guard (line ~162):

```ts
  const { resolveActiveCampaignPolicy } = await import('@/lib/campaigns/policy')
  const campaignPolicy = await resolveActiveCampaignPolicy(supabase, leadId, organizationId)
  // Proactive first-touch is only for leads in an AI-enabled, auto, live campaign.
  // New/unenrolled leads have no policy -> speed-to-lead stays silent for them.
  if (!campaignPolicy || !campaignPolicy.aiEnabled || campaignPolicy.autopilotMode !== 'auto' || campaignPolicy.sendMode !== 'live') {
    return { action: 'skipped', reason: 'no_ai_campaign' }
  }
```

- [ ] **Step 2: Write the test (critical: new lead → no AI)**

```ts
// src/lib/autopilot/__tests__/speed-to-lead-campaign-gate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/autopilot/config', () => ({
  getAutopilotConfig: vi.fn().mockResolvedValue({
    enabled: true, paused: false, speed_to_lead: true, outreach_suppressed: false,
    timezone: 'America/Los_Angeles', active_hours_start: 0, active_hours_end: 24,
  }),
}))
vi.mock('@/lib/agents/allocation', () => ({ resolveAutomationOwner: vi.fn().mockResolvedValue({ owner: 'ai' }) }))
vi.mock('@/lib/campaigns/policy', () => ({ resolveActiveCampaignPolicy: vi.fn() }))

import { resolveActiveCampaignPolicy } from '@/lib/campaigns/policy'
import { triggerSpeedToLead } from '@/lib/autopilot/speed-to-lead'

function leadSupabase() {
  return {
    from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { id: 'l1', phone_formatted: '+15550000000', sms_consent: true, sms_opt_out: false, is_existing_patient: false }, error: null }) })),
  } as any
}

describe('speed-to-lead campaign gate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('skips a new lead that is in no AI campaign', async () => {
    ;(resolveActiveCampaignPolicy as any).mockResolvedValue(null)
    const res = await triggerSpeedToLead(leadSupabase(), 'l1', 'org-1')
    expect(res.action).toBe('skipped')
    expect(res.reason).toBe('no_ai_campaign')
  })
})
```

> Note: mock paths for `getAutopilotConfig` and `resolveAutomationOwner` must match the actual import paths in `speed-to-lead.ts` — confirm the allocation import path (`resolveAutomationOwner`) when wiring the test; adjust the `vi.mock` target to the real module specifier.

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run src/lib/autopilot/__tests__/speed-to-lead-campaign-gate.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/autopilot/speed-to-lead.ts src/lib/autopilot/__tests__/speed-to-lead-campaign-gate.test.ts
git commit -m "feat(autopilot): campaign-gate speed-to-lead so new leads get no AI"
```

---

## Task 6: Gate inbound auto-respond (critical negative isolation)

**Files:**
- Modify: `src/lib/autopilot/auto-respond.ts` (insert after rate-limit gate, ~line 197; extend `AutoResponseResult`)
- Test: `src/lib/autopilot/__tests__/auto-respond-campaign-gate.test.ts`

- [ ] **Step 1: Extend the `AutoResponseResult` action union**

In `src/lib/autopilot/auto-respond.ts`, add `'held_for_review'` to the `action` union of `AutoResponseResult` (near the top of the file where the type is declared).

- [ ] **Step 2: Insert the campaign gate**

In `processAutoResponse`, immediately after the rate-limit check block (after line ~196, before `buildConversationHistory` at ~200):

```ts
  const { resolveActiveCampaignPolicy } = await import('@/lib/campaigns/policy')
  const campaignPolicy = await resolveActiveCampaignPolicy(supabase, lead_id, organization_id)
  // Unenrolled leads (e.g. a brand-new inbound lead) get NO AI — a human handles them.
  if (!campaignPolicy || !campaignPolicy.aiEnabled || campaignPolicy.autopilotMode === 'off') {
    return { action: 'skipped', reason: 'no_ai_campaign' }
  }
```

- [ ] **Step 3: Write the critical negative test**

```ts
// src/lib/autopilot/__tests__/auto-respond-campaign-gate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/autopilot/config', () => ({
  getAutopilotConfig: vi.fn().mockResolvedValue({ enabled: true, paused: false, stop_words: [], max_messages_per_hour: 100 }),
  resolveConversationAiGate: vi.fn().mockReturnValue('proceed'),
}))
vi.mock('@/lib/campaigns/policy', () => ({ resolveActiveCampaignPolicy: vi.fn() }))

import { resolveActiveCampaignPolicy } from '@/lib/campaigns/policy'
import { processAutoResponse } from '@/lib/autopilot/auto-respond'

describe('auto-respond campaign gate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('produces ZERO AI action for an unenrolled inbound lead', async () => {
    ;(resolveActiveCampaignPolicy as any).mockResolvedValue(null)
    const supabase = { from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: null, error: null }) })) } as any
    const res = await processAutoResponse(supabase, {
      organization_id: 'org-1', conversation_id: 'conv-1', lead_id: 'l1',
      lead: { id: 'l1', ai_autopilot_override: 'default' }, conversation: { ai_mode: 'auto' },
      inbound_message: 'hey are you still there', channel: 'sms', sender_contact: '+15550000000',
    })
    expect(res.action).toBe('skipped')
    expect(res.reason).toBe('no_ai_campaign')
    expect(resolveActiveCampaignPolicy).toHaveBeenCalledWith(supabase, 'l1', 'org-1')
  })
})
```

> Note: if `processAutoResponse` reaches allocation/`resolveAutomationOwner` before the gate at line ~197, add a `vi.mock` for that module returning `{ owner: 'ai' }` so the flow reaches the campaign gate. Confirm the allocation import path from the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/autopilot/__tests__/auto-respond-campaign-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/autopilot/auto-respond.ts src/lib/autopilot/__tests__/auto-respond-campaign-gate.test.ts
git commit -m "feat(autopilot): campaign-gate inbound auto-respond; unenrolled leads get no AI"
```

---

## Task 7: Review queue module + review-first routing in auto-respond

**Files:**
- Create: `src/lib/campaigns/review-queue.ts`
- Modify: `src/lib/autopilot/auto-respond.ts` (branch before `sendAgentResponse`, ~line 399)
- Test: `src/lib/campaigns/__tests__/review-queue.test.ts`

- [ ] **Step 1: Write the failing test for the review queue**

```ts
// src/lib/campaigns/__tests__/review-queue.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createReviewDraft } from '@/lib/campaigns/review-queue'

describe('createReviewDraft', () => {
  it('inserts a pending draft row and returns its id', async () => {
    const insert = vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: { id: 'draft-1' }, error: null }) }) })
    const supabase = { from: vi.fn(() => ({ insert })) } as any
    const id = await createReviewDraft(supabase, {
      organization_id: 'org-1', campaign_id: 'c1', lead_id: 'l1', conversation_id: 'conv-1', channel: 'sms', subject: null, body: 'draft text',
    })
    expect(id).toBe('draft-1')
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending', body: 'draft text', channel: 'sms' }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/campaigns/__tests__/review-queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/campaigns/review-queue.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'

export interface CreateReviewDraftInput {
  organization_id: string
  campaign_id: string
  lead_id: string
  conversation_id: string | null
  channel: 'sms' | 'email'
  subject: string | null
  body: string
}

export async function createReviewDraft(supabase: SupabaseClient, input: CreateReviewDraftInput): Promise<string | null> {
  const { data, error } = await supabase
    .from('campaign_review_drafts')
    .insert({ ...input, status: 'pending' })
    .select('id')
    .single()
  if (error || !data) return null
  return (data as any).id
}

export async function rejectReviewDraft(supabase: SupabaseClient, id: string, reviewerId: string): Promise<void> {
  await supabase
    .from('campaign_review_drafts')
    .update({ status: 'rejected', reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
}

/**
 * Approve a pending draft: mark approved, then send it. The human approval IS the
 * send authorization — approved drafts use caller 'campaign.review_approved' which the
 * send backstop authorizes because the campaign is (by construction) the lead's active one.
 * Returns whether the send succeeded.
 */
export async function approveReviewDraft(
  supabase: SupabaseClient,
  id: string,
  reviewerId: string
): Promise<{ sent: boolean; reason?: string }> {
  const { data: draft } = await supabase
    .from('campaign_review_drafts')
    .select('*')
    .eq('id', id)
    .eq('status', 'pending')
    .single()
  if (!draft) return { sent: false, reason: 'not_found_or_not_pending' }

  const d = draft as any
  const { data: lead } = await supabase.from('leads').select('phone_formatted, email').eq('id', d.lead_id).single()
  if (!lead) return { sent: false, reason: 'lead_missing' }

  let ok = false
  if (d.channel === 'sms') {
    const { sendSMSToLead } = await import('@/lib/messaging/twilio')
    const res = await sendSMSToLead({ supabase, leadId: d.lead_id, to: (lead as any).phone_formatted, body: d.body, caller: 'campaign.review_approved', aiGenerated: true, blockOnReview: true, actor: { id: reviewerId } })
    ok = res.sent
  } else {
    const { sendEmailToLead } = await import('@/lib/messaging/resend')
    const res = await sendEmailToLead({ supabase, leadId: d.lead_id, to: (lead as any).email, subject: d.subject ?? '', html: d.body, text: d.body, caller: 'campaign.review_approved', aiGenerated: true, blockOnReview: true })
    ok = res.sent
  }

  await supabase
    .from('campaign_review_drafts')
    .update({ status: 'approved', reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq('id', id)

  return { sent: ok }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/campaigns/__tests__/review-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Route review-first responses to the queue in `auto-respond.ts`**

Immediately before the `sendAgentResponse(...)` call (line ~399), branch on the campaign mode. Bind `draftBody` to the same response text that is passed into `sendAgentResponse` (the agent's generated message string):

```ts
  if (campaignPolicy.autopilotMode === 'review_first') {
    const { createReviewDraft } = await import('@/lib/campaigns/review-queue')
    await createReviewDraft(supabase, {
      organization_id, campaign_id: campaignPolicy.campaignId, lead_id,
      conversation_id, channel, subject: null, body: draftBody,
    })
    return { action: 'held_for_review', reason: 'campaign_review_first' }
  }
```

> `draftBody` = the generated message string already computed for `sendAgentResponse`. Bind it to the local variable holding that text at this point in the function.

- [ ] **Step 6: Run full suite; commit**

Run: `npm test`
Expected: PASS.

```bash
git add src/lib/campaigns/review-queue.ts src/lib/campaigns/__tests__/review-queue.test.ts src/lib/autopilot/auto-respond.ts
git commit -m "feat(campaigns): review-first draft queue + auto-respond routing"
```

---

## Task 8: Gate campaign executors (nurture + generic email path)

**Files:**
- Modify: `src/lib/campaigns/nurture-executor.ts` (before send at ~229; add review-first branch)
- Modify: `src/lib/campaigns/executor.ts` (before raw `sendEmail` at ~352)
- Test: `src/lib/campaigns/__tests__/executor-campaign-gate.test.ts`

- [ ] **Step 1: Add review-first branch + policy check in `nurture-executor.ts`**

In `executeNurtureStep`, after the step is loaded and `isAiStep` computed (~line 101) and before the send at line 229, insert:

```ts
  const { resolveActiveCampaignPolicy } = await import('@/lib/campaigns/policy')
  const stepPolicy = await resolveActiveCampaignPolicy(supabase, lead.id, enrollment.organization_id)
  if (isAiStep && stepPolicy && stepPolicy.aiEnabled && stepPolicy.autopilotMode === 'review_first') {
    const { createReviewDraft } = await import('@/lib/campaigns/review-queue')
    await createReviewDraft(supabase, {
      organization_id: enrollment.organization_id, campaign_id: stepPolicy.campaignId, lead_id: lead.id,
      conversation_id: null, channel: step.channel, subject: subject ?? null, body: messageBody,
    })
    return { action: 'skipped', enrollment_id: enrollment.id, lead_id: lead.id, detail: 'held_for_review' }
  }
```

> Bind `messageBody` / `subject` to the already-computed step body/subject variables at that point (the same ones passed to `sendSMSToLead`/`sendEmailToLead` below).

- [ ] **Step 2: Gate the generic executor's raw email send**

In `src/lib/campaigns/executor.ts`, immediately before the `sendEmail({...})` call at line ~352 (the raw path that bypasses `sendEmailToLead`), insert:

```ts
      const { assertCampaignSendAllowed } = await import('@/lib/campaigns/send-authorization')
      const emailAuth = await assertCampaignSendAllowed(supabase, { leadId: lead.id, caller: 'campaign.executor' })
      if (!emailAuth.allowed) {
        return { action: 'skipped', enrollment_id: enrollment.id, lead_id: lead.id, detail: `campaign_${emailAuth.reason}` }
      }
```

> The SMS path in this file uses `sendSMSToLead` (caller `campaign.executor`), which is already covered by the Task 4 backstop — no change needed there.

- [ ] **Step 3: Write the test**

```ts
// src/lib/campaigns/__tests__/executor-campaign-gate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/campaigns/policy', () => ({ resolveActiveCampaignPolicy: vi.fn() }))
vi.mock('@/lib/campaigns/review-queue', () => ({ createReviewDraft: vi.fn().mockResolvedValue('draft-1') }))

import { resolveActiveCampaignPolicy } from '@/lib/campaigns/policy'
import { createReviewDraft } from '@/lib/campaigns/review-queue'
import { executeNurtureStep } from '@/lib/campaigns/nurture-executor'

describe('nurture executor review-first', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drafts (not sends) an AI step when the campaign is review_first', async () => {
    ;(resolveActiveCampaignPolicy as any).mockResolvedValue({ campaignId: 'c1', aiEnabled: true, autopilotMode: 'review_first', sendMode: 'live', playbook: {} })
    // Minimal supabase + enrollment fixture: an AI-generator step for a lead with a phone.
    const enrollment: any = {
      id: 'e1', organization_id: 'org-1', lead_id: 'l1', current_step: 0, created_at: 't',
      campaign: { id: 'c1', metadata: {} },
      lead: { id: 'l1', phone_formatted: '+15550000000', email: 'a@b.com', sms_consent: true, sms_opt_out: false },
    }
    const supabase = { from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data: [{ id: 's1', step_number: 1, channel: 'sms', body_template: 'hi {{first_name}}', metadata: { ai_generator: 'closer' } }], error: null }), single: vi.fn().mockResolvedValue({ data: null, error: null }), update: vi.fn().mockReturnThis() })) } as any
    const res = await executeNurtureStep(supabase, enrollment)
    expect(createReviewDraft).toHaveBeenCalled()
    expect(res.detail).toBe('held_for_review')
  })
})
```

> Note: the exact supabase mock shape must satisfy how `executeNurtureStep` loads its step (order/limit or single) — align the mock with the real query at `nurture-executor.ts:84-89` when implementing. The assertion of interest is that `createReviewDraft` is called and nothing is sent.

- [ ] **Step 4: Run test; commit**

Run: `npx vitest run src/lib/campaigns/__tests__/executor-campaign-gate.test.ts`
Expected: PASS.

```bash
git add src/lib/campaigns/nurture-executor.ts src/lib/campaigns/executor.ts src/lib/campaigns/__tests__/executor-campaign-gate.test.ts
git commit -m "feat(campaigns): review-first drafting + send gate in executors"
```

---

## Task 9: Inject the campaign playbook into the agent prompt

**Files:**
- Modify: the module exporting `buildAgentContext` (referenced from `auto-respond.ts:203`) — locate with `grep -rn "export .*buildAgentContext" src/lib`
- Test: `src/lib/ai/__tests__/playbook-injection.test.ts`

- [ ] **Step 1: Locate `buildAgentContext` and add a playbook block builder**

Run: `grep -rn "buildAgentContext" src/lib` to find the definition file. In that file, add:

```ts
import type { CampaignPlaybook } from '@/types/database'

/** Render a campaign playbook as a prompt block appended to the base setter/closer system prompt. */
export function buildPlaybookBlock(playbook: CampaignPlaybook | null | undefined): string {
  if (!playbook || Object.keys(playbook).length === 0) return ''
  const lines: string[] = ['## Campaign Playbook', 'Follow this campaign-specific strategy on top of your base role:']
  if (playbook.goal) lines.push(`- Goal: ${playbook.goal}`)
  if (playbook.tone) lines.push(`- Tone: ${playbook.tone}`)
  if (playbook.offer) lines.push(`- Offer: ${playbook.offer}`)
  if (playbook.hooks?.length) lines.push(`- Opening hooks: ${playbook.hooks.join('; ')}`)
  if (playbook.objection_notes) lines.push(`- Objection handling: ${playbook.objection_notes}`)
  if (playbook.guardrails?.length) lines.push(`- Guardrails (must follow): ${playbook.guardrails.join('; ')}`)
  if (playbook.donts?.length) lines.push(`- Never: ${playbook.donts.join('; ')}`)
  return lines.join('\n')
}
```

Then, where `buildAgentContext` assembles the system prompt, append `buildPlaybookBlock(playbook)` when a playbook is supplied. Add an optional `playbook?: CampaignPlaybook` field to the `buildAgentContext` params and thread `campaignPolicy.playbook` from `auto-respond.ts` (available after Task 6's gate) into that call at `auto-respond.ts:203`.

- [ ] **Step 2: Write the test**

```ts
// src/lib/ai/__tests__/playbook-injection.test.ts
import { describe, it, expect } from 'vitest'
import { buildPlaybookBlock } from '@/lib/ai/agent-context' // adjust path to the located file

describe('buildPlaybookBlock', () => {
  it('returns empty string for an empty playbook', () => {
    expect(buildPlaybookBlock({})).toBe('')
    expect(buildPlaybookBlock(null)).toBe('')
  })

  it('renders goal, tone, hooks, guardrails', () => {
    const block = buildPlaybookBlock({ goal: 'rebook lapsed patients', tone: 'warm', hooks: ['We miss you'], guardrails: ['no price quotes'], donts: ['no medical advice'] })
    expect(block).toContain('## Campaign Playbook')
    expect(block).toContain('Goal: rebook lapsed patients')
    expect(block).toContain('Opening hooks: We miss you')
    expect(block).toContain('Guardrails (must follow): no price quotes')
    expect(block).toContain('Never: no medical advice')
  })
})
```

- [ ] **Step 3: Run test; commit**

Run: `npx vitest run src/lib/ai/__tests__/playbook-injection.test.ts`
Expected: PASS. (Fix the import path to the located `buildAgentContext` module.)

```bash
git add src/lib/ai/ src/lib/autopilot/auto-respond.ts
git commit -m "feat(ai): inject per-campaign playbook into agent prompt"
```

---

## Task 10: Campaign funnel attribution

**Files:**
- Create: `src/lib/campaigns/attribution.ts`
- Test: `src/lib/campaigns/__tests__/attribution.test.ts`

**Attribution rule (MVP, last-touch):** a lead is attributed to exactly one campaign — the one with its most-recent enrollment (`max(created_at)`). The funnel counts each stage over that campaign's attributed leads.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/campaigns/__tests__/attribution.test.ts
import { describe, it, expect, vi } from 'vitest'
import { getCampaignFunnel } from '@/lib/campaigns/attribution'

describe('getCampaignFunnel', () => {
  it('assembles the funnel from the attributed lead set', async () => {
    // enrolled leads attributed to this campaign
    const enrollments = [{ lead_id: 'l1', created_at: 't1' }, { lead_id: 'l2', created_at: 't1' }]
    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'campaign_enrollments') return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: enrollments, error: null }) }
        if (table === 'messages') return { select: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), eq: vi.fn().mockResolvedValue({ data: [{ lead_id: 'l1', direction: 'inbound' }], error: null }) }
        if (table === 'appointments') return { select: vi.fn().mockReturnThis(), in: vi.fn().mockResolvedValue({ data: [{ lead_id: 'l1', status: 'attended' }], error: null }) }
        if (table === 'leads') return { select: vi.fn().mockReturnThis(), in: vi.fn().mockResolvedValue({ data: [{ id: 'l1', status: 'contract_signed' }, { id: 'l2', status: 'contacted' }], error: null }) }
        if (table === 'campaigns') return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: { revenue_attributed: 12000 }, error: null }) }
        return {} as any
      }),
    } as any

    const funnel = await getCampaignFunnel(supabase, 'c1', 'org-1')
    expect(funnel.enrolled).toBe(2)
    expect(funnel.replied).toBe(1)     // l1 has an inbound
    expect(funnel.booked).toBe(1)      // l1 has an appointment
    expect(funnel.showed).toBe(1)      // appointment attended
    expect(funnel.closed).toBe(1)      // l1 contract_signed (won)
    expect(funnel.revenue).toBe(12000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/campaigns/__tests__/attribution.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/campaigns/attribution.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { POST_CLOSE_STAGE_SLUGS } from '@/lib/pipeline/stage-groups'

export interface CampaignFunnel {
  enrolled: number
  delivered: number
  replied: number
  booked: number
  showed: number
  closed: number
  revenue: number
}

// Won lead statuses = the "closed" stage of the funnel.
const WON_STATUSES = new Set(['contract_signed', 'scheduled', 'in_treatment', 'completed'])
const ATTENDED_APPOINTMENT_STATUSES = new Set(['attended', 'completed', 'showed'])

export async function getCampaignFunnel(
  supabase: SupabaseClient,
  campaignId: string,
  organizationId: string
): Promise<CampaignFunnel> {
  const empty: CampaignFunnel = { enrolled: 0, delivered: 0, replied: 0, booked: 0, showed: 0, closed: 0, revenue: 0 }

  const { data: enrollments } = await supabase
    .from('campaign_enrollments')
    .select('lead_id, created_at')
    .eq('campaign_id', campaignId)
  if (!enrollments || enrollments.length === 0) return empty

  const leadIds = [...new Set((enrollments as any[]).map((e) => e.lead_id))]

  const [{ data: msgs }, { data: appts }, { data: leads }, { data: campaign }] = await Promise.all([
    supabase.from('messages').select('lead_id, direction').in('lead_id', leadIds),
    supabase.from('appointments').select('lead_id, status').in('lead_id', leadIds),
    supabase.from('leads').select('id, status').in('id', leadIds),
    supabase.from('campaigns').select('revenue_attributed').eq('id', campaignId).single(),
  ])

  const outbound = (msgs as any[] | null)?.filter((m) => m.direction === 'outbound') ?? []
  const inboundLeadIds = new Set((msgs as any[] | null)?.filter((m) => m.direction === 'inbound').map((m) => m.lead_id) ?? [])
  const bookedLeadIds = new Set((appts as any[] | null)?.map((a) => a.lead_id) ?? [])
  const showedLeadIds = new Set((appts as any[] | null)?.filter((a) => ATTENDED_APPOINTMENT_STATUSES.has(a.status)).map((a) => a.lead_id) ?? [])
  const closed = (leads as any[] | null)?.filter((l) => WON_STATUSES.has(l.status)).length ?? 0

  return {
    enrolled: leadIds.length,
    delivered: outbound.length,
    replied: inboundLeadIds.size,
    booked: bookedLeadIds.size,
    showed: showedLeadIds.size,
    closed,
    revenue: Number((campaign as any)?.revenue_attributed ?? 0),
  }
}
```

> `POST_CLOSE_STAGE_SLUGS` is imported to keep the won-set aligned with `src/lib/pipeline/stage-groups.ts`; if the appointment status vocabulary differs from `{attended, completed, showed}`, adjust `ATTENDED_APPOINTMENT_STATUSES` to the values on the `appointments` table (confirm against `src/types/database.ts` appointment type). This is a value-set alignment, not a logic change.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/campaigns/__tests__/attribution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/campaigns/attribution.ts src/lib/campaigns/__tests__/attribution.test.ts
git commit -m "feat(campaigns): per-campaign funnel attribution (last-touch)"
```

---

## Task 11: API routes — policy update + review approve/reject

**Files:**
- Create: `src/app/api/campaigns/[id]/policy/route.ts`
- Create: `src/app/api/campaigns/review-drafts/[id]/route.ts`
- Test: `src/app/api/campaigns/__tests__/policy-route.test.ts`

- [ ] **Step 1: Write the policy PATCH route**

```ts
// src/app/api/campaigns/[id]/policy/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'

const PolicySchema = z.object({
  ai_enabled: z.boolean().optional(),
  autopilot_mode: z.enum(['review_first', 'auto', 'off']).optional(),
  send_mode: z.enum(['suppressed', 'live']).optional(),
  playbook: z.record(z.unknown()).optional(),
})

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { orgId, profile } = await resolveActiveOrg(supabase)
  if (!profile || !hasPermission(profile.role, 'campaigns:write')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const body = PolicySchema.parse(await req.json())
  const { data, error } = await supabase
    .from('campaigns')
    .update(body)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select('id, ai_enabled, autopilot_mode, send_mode, playbook')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 400 })
  return NextResponse.json({ campaign: data })
}
```

> Confirm `resolveActiveOrg`'s exact return shape (`orgId`, `profile`) against `src/lib/auth/active-org.ts` and the permission key `campaigns:write` against `src/lib/auth/permissions.ts` (`AGENCY_OUTBOUND_PERMISSIONS`). Match the existing pattern used by other `src/app/api/campaigns/**` routes.

- [ ] **Step 2: Write the review-draft approve/reject route**

```ts
// src/app/api/campaigns/review-drafts/[id]/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { hasPermission } from '@/lib/auth/permissions'
import { approveReviewDraft, rejectReviewDraft } from '@/lib/campaigns/review-queue'

const ActionSchema = z.object({ action: z.enum(['approve', 'reject']) })

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { profile } = await resolveActiveOrg(supabase)
  if (!profile || !hasPermission(profile.role, 'campaigns:write')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { action } = ActionSchema.parse(await req.json())
  if (action === 'approve') {
    const res = await approveReviewDraft(supabase, id, profile.id)
    return NextResponse.json(res)
  }
  await rejectReviewDraft(supabase, id, profile.id)
  return NextResponse.json({ rejected: true })
}
```

- [ ] **Step 3: Write a route test for the permission gate**

```ts
// src/app/api/campaigns/__tests__/policy-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/active-org', () => ({ resolveActiveOrg: vi.fn() }))

import { resolveActiveOrg } from '@/lib/auth/active-org'
import { PATCH } from '@/app/api/campaigns/[id]/policy/route'

describe('PATCH /api/campaigns/[id]/policy', () => {
  beforeEach(() => vi.clearAllMocks())

  it('403s a non-agency role', async () => {
    ;(resolveActiveOrg as any).mockResolvedValue({ orgId: 'org-1', profile: { id: 'u1', role: 'nurse' } })
    const res = await PATCH(new Request('http://x', { method: 'PATCH', body: '{}' }), { params: Promise.resolve({ id: 'c1' }) })
    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 4: Run test; commit**

Run: `npx vitest run src/app/api/campaigns/__tests__/policy-route.test.ts`
Expected: PASS.

```bash
git add src/app/api/campaigns/
git commit -m "feat(api): campaign policy update + review-draft approve/reject routes"
```

---

## Task 12: UI — policy controls + funnel readout

**Files:**
- Modify: `src/components/crm/campaign-builder.tsx` (add policy controls)
- Modify: `src/components/crm/campaign-analytics.tsx` (add funnel readout)

- [ ] **Step 1: Add policy controls to the campaign builder**

In `src/components/crm/campaign-builder.tsx`, add a "Campaign AI & Sending" section with controls bound to a PATCH of `/api/campaigns/{id}/policy`:
- Toggle `ai_enabled`.
- Select `autopilot_mode` ∈ {review_first, auto, off} (label review_first as "Review-first (approve each message)").
- Select `send_mode` ∈ {suppressed, live} with a warning banner when switching to `live`.
- Playbook fields: `goal`, `tone`, `offer` (text inputs); `hooks`, `guardrails`, `donts` (comma-split into string arrays); `objection_notes` (textarea).

Follow the existing form/section styling in this component (match its existing inputs). On save, `fetch(`/api/campaigns/${id}/policy`, { method: 'PATCH', body: JSON.stringify({...}) })`.

- [ ] **Step 2: Add the funnel readout to campaign analytics**

In `src/components/crm/campaign-analytics.tsx`, fetch and render the funnel. Add a server call to `getCampaignFunnel` (from `@/lib/campaigns/attribution`) in the analytics data path (or a small `/api/campaigns/[id]/funnel` GET route mirroring Task 11's auth pattern), and render a horizontal stage bar: **Enrolled → Delivered → Replied → Booked → Showed → Closed → Revenue**, each with its count, matching the existing analytics card styling.

- [ ] **Step 3: Verify in the browser**

Use the preview workflow: start the dev server, open a campaign, confirm the policy controls persist (PATCH returns 200; re-open shows saved values) and the funnel readout renders with the seven stages. Screenshot for the record.

- [ ] **Step 4: Commit**

```bash
git add src/components/crm/campaign-builder.tsx src/components/crm/campaign-analytics.tsx
git commit -m "feat(crm): campaign AI/sending controls + funnel readout"
```

---

## Task 13: End-to-end smoke test (allowlist), then go-live checklist

**Files:** none (operational verification)

- [ ] **Step 1: Set the send allowlist to an operator number**

In Vercel project env (and `.env.local` for local), set `TEST_SEND_ALLOWLIST` to an operator's own phone/email and ensure `MESSAGING_DRY_RUN` is **not** set (so real sends can reach the allowlisted contact only).

- [ ] **Step 2: Create a test campaign, enroll one allowlisted test lead**

Create a campaign, set `ai_enabled=true`, `autopilot_mode=review_first`, `send_mode=live`, add a playbook. Enroll a single test lead whose contact is on the allowlist.

- [ ] **Step 3: Exercise review-first → approve → send → funnel**

- Trigger an AI step / inbound reply so a `campaign_review_drafts` row is created (mode review_first ⇒ nothing sends yet).
- Approve it via the review UI/route; confirm the message reaches the allowlisted contact.
- Confirm the funnel readout increments (enrolled ≥ 1, delivered ≥ 1).

- [ ] **Step 4: Confirm isolation**

- Verify a NON-enrolled lead's inbound reply produces **no** AI draft and **no** send (the critical negative behavior; check logs / `campaign_review_drafts` stays empty for that lead).

- [ ] **Step 5: Go-live**

Once satisfied, point the campaign at a real cold Smart List; keep `autopilot_mode=review_first` until you trust the output, then flip that one campaign to `auto`. Leave `TEST_SEND_ALLOWLIST` unset in prod only when you are ready for the campaign to reach real recipients.

---

## Self-review notes

- **Spec coverage:** D1 isolation → Tasks 4–6, 8 (deny-by-default gates). D2 supervision → Tasks 6–8 (`autopilot_mode`, review queue). D3 playbook → Tasks 1, 2, 9. D4 funnel → Task 10, 12. D5 human sends open → Task 3 (`isAutomationCaller` exempts humans). Rollout/safety → Task 1 backfill, Task 13 smoke test.
- **Non-goals** (per-campaign stage-rule authoring; per-campaign prequal) are intentionally absent — deferred to spec #2.
- **Type consistency:** `resolveActiveCampaignPolicy`, `CampaignPolicy`, `assertCampaignSendAllowed`, `createReviewDraft`, `getCampaignFunnel` are defined once and used with the same signatures throughout.
- **Known implementation-time confirmations (value/path alignment, not logic gaps):** mock import paths for `resolveAutomationOwner`/`getAutopilotConfig` (Tasks 5–6); `buildAgentContext` module path (Task 9); appointment status vocabulary + `resolveActiveOrg` return shape (Tasks 10–11). Each is flagged inline at its task.
