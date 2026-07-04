# Full Audit Trail (Human + AI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a universal, tamper-evident audit trail that records every consequential mutation, outbound communication, and AI decision — attributed to the human, AI agent, cron, or webhook that caused it — and surface it as a readable timeline.

**Architecture:** Hybrid capture. Postgres `AFTER` triggers on a curated set of tables guarantee coverage (they fire even on direct SQL and service-role writes) and compute before/after diffs; an app-layer `recordAudit()` helper adds rich context for comms and AI actions. Both write to a new append-only `audit_events` table hardened with the existing `prevent_row_mutation()` WORM trigger. Actor identity reaches the DB triggers through Postgres session GUCs set per request. PHI reads continue to live in `hipaa_audit_log`; the UI unions both.

**Tech Stack:** Supabase/Postgres (plpgsql triggers, RLS, GUCs), Next.js 16 App Router, TypeScript, vitest, Tailwind/shadcn.

---

## Reference: existing patterns this plan builds on

- Append-only trigger `public.prevent_row_mutation()` and the WORM pattern: `supabase/migrations/20260604_append_only_audit_logs.sql`.
- PHI event insert shape: `src/lib/ai/hipaa.ts::logHIPAAEvent` (writes `hipaa_audit_log` with `metadata` jsonb; actor enum `user|system|ai_agent|cron|webhook`).
- Never-throw audit failure pattern: `src/lib/hipaa-audit.ts::handleAuditFailure`.
- Org resolution / actor identity: `src/lib/auth/active-org.ts::getOwnProfile`, `resolveActiveOrg`.
- Service client: `src/lib/supabase/server.ts::createServiceClient` (bypasses RLS — the reason triggers need GUC-based actor plumbing).
- RLS convention: policies use `organization_id = public.get_user_org_id()`.
- Migration column conventions: `id uuid primary key default gen_random_uuid()`, `organization_id uuid not null references public.organizations(id) on delete cascade`, `timestamptz default now()`, `jsonb default '{}'`.
- Apply migrations with `supabase db query --linked -f <file>` (NOT `db push` — same-day 8-digit filenames collide).
- `npm run build` (`tsc` via `next build`) must be green before push — type errors, including in tests, fail Vercel.

---

## File structure

**New — pure logic (unit-tested with vitest):**
- `src/lib/audit/types.ts` — shared types: `ActorType`, `AuditActor`, `AiContext`, `AuditEventInput`, `TimelineRow`.
- `src/lib/audit/redaction.ts` — `SENSITIVE_COLUMNS` denylist + `redactRow(table, row)`.
- `src/lib/audit/diff.ts` — `computeChangedFields(before, after)`.
- `src/lib/audit/query.ts` — `normalizeTimeline(auditRows, hipaaRows)` (pure) + `fetchAuditTimeline(...)` (DB).

**New — DB-touching:**
- `src/lib/audit/actor.ts` — `resolveActor(supabase)` + `withAuditActor(serviceClient, actor)`.
- `src/lib/audit/record.ts` — `recordAudit(ctx, event)` (never throws).

**New — surface:**
- `src/app/api/audit/route.ts` — `GET /api/audit`.
- `src/components/audit/AuditTimeline.tsx` — reusable timeline.
- `src/app/(dashboard)/audit/page.tsx` — agency `/audit` page.

**New — migration:**
- `supabase/migrations/20260704160000_audit_events.sql`.

**Modified — AI instrumentation:**
- Voice agent action site, autopilot SMS site, mass-send site (exact files located in Task 12).
- One shared route/service entrypoint to call `withAuditActor` (Task 8).

**New — tests:**
- `src/lib/audit/__tests__/{diff,redaction,query,record,actor}.test.ts`.
- `docs/superpowers/plans/audit-sql-smoke.md` — copy-paste SQL to verify trigger + append-only + RLS against the linked DB.

---

## Phase 1 — Pure logic (no DB)

### Task 1: Shared types

**Files:**
- Create: `src/lib/audit/types.ts`

- [ ] **Step 1: Write the types**

```typescript
// src/lib/audit/types.ts
export type ActorType = 'user' | 'system' | 'ai_agent' | 'cron' | 'webhook'

export type AuditSource = 'db_trigger' | 'api_route' | 'cron' | 'webhook'

export type AgentRole = 'setter' | 'closer' | 'autopilot' | 'voice'

export type AiContext = {
  model?: string
  agent_role?: AgentRole
  autonomous: boolean
  approved_by?: string | null
  gate?: string
  confidence?: number
}

export type AuditActor = {
  actorType: ActorType
  actorId?: string | null
  actorLabel?: string | null
  requestId?: string | null
}

export type AuditEventInput = {
  organizationId: string
  action: string
  actor: AuditActor
  source: AuditSource
  resourceType?: string | null
  resourceId?: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  changedFields?: string[] | null
  ai?: AiContext | null
  severity?: 'info' | 'warning' | 'critical'
  metadata?: Record<string, unknown>
}

export type TimelineRow = {
  id: string
  occurredAt: string
  actorType: ActorType
  actorLabel: string | null
  action: string
  resourceType: string | null
  resourceId: string | null
  changedFields: string[]
  ai: AiContext | null
  severity: string
  origin: 'audit_events' | 'hipaa_audit_log'
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no references yet).

- [ ] **Step 3: Commit**

```bash
git add src/lib/audit/types.ts
git commit -m "feat(audit): shared audit types"
```

---

### Task 2: Diff computation

**Files:**
- Create: `src/lib/audit/diff.ts`
- Test: `src/lib/audit/__tests__/diff.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/audit/__tests__/diff.test.ts
import { describe, it, expect } from 'vitest'
import { computeChangedFields } from '@/lib/audit/diff'

describe('computeChangedFields', () => {
  it('returns keys whose values differ', () => {
    const before = { stage: 'new', name: 'Ada', score: 10 }
    const after = { stage: 'won', name: 'Ada', score: 10 }
    expect(computeChangedFields(before, after)).toEqual(['stage'])
  })

  it('treats added and removed keys as changed', () => {
    expect(computeChangedFields({ a: 1 }, { a: 1, b: 2 })).toEqual(['b'])
    expect(computeChangedFields({ a: 1, b: 2 }, { a: 1 })).toEqual(['b'])
  })

  it('compares nested values structurally, not by reference', () => {
    const before = { tags: ['x'] }
    const after = { tags: ['x'] }
    expect(computeChangedFields(before, after)).toEqual([])
  })

  it('handles null before (insert) and null after (delete)', () => {
    expect(computeChangedFields(null, { a: 1 })).toEqual(['a'])
    expect(computeChangedFields({ a: 1 }, null)).toEqual(['a'])
    expect(computeChangedFields(null, null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/audit/__tests__/diff.test.ts`
Expected: FAIL — cannot find module `@/lib/audit/diff`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/audit/diff.ts
type Row = Record<string, unknown> | null | undefined

export function computeChangedFields(before: Row, after: Row): string[] {
  const b = before ?? {}
  const a = after ?? {}
  const keys = new Set([...Object.keys(b), ...Object.keys(a)])
  const changed: string[] = []
  for (const key of keys) {
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) changed.push(key)
  }
  return changed
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/audit/__tests__/diff.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/audit/diff.ts src/lib/audit/__tests__/diff.test.ts
git commit -m "feat(audit): changed-fields diff"
```

---

### Task 3: Column redaction

**Files:**
- Create: `src/lib/audit/redaction.ts`
- Test: `src/lib/audit/__tests__/redaction.test.ts`

Redaction keeps encrypted/hashed PII out of `before`/`after` snapshots. The same
denylist is mirrored in the SQL trigger (Task 7) — keep them in sync; the SQL
copy carries a comment pointing here.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/audit/__tests__/redaction.test.ts
import { describe, it, expect } from 'vitest'
import { redactRow, SENSITIVE_COLUMNS } from '@/lib/audit/redaction'

describe('redactRow', () => {
  it('replaces denylisted columns for the table with a sentinel', () => {
    const row = { id: '1', stage: 'won', email: 'a@b.com', phone: '+15551234567' }
    const out = redactRow('leads', row)
    expect(out.stage).toBe('won')
    expect(out.email).toBe('[redacted]')
    expect(out.phone).toBe('[redacted]')
  })

  it('leaves rows for non-configured tables untouched', () => {
    const row = { id: '1', foo: 'bar' }
    expect(redactRow('connector_configs', row)).toEqual(row)
  })

  it('only redacts keys that are present', () => {
    const out = redactRow('leads', { id: '1', stage: 'won' })
    expect(out).toEqual({ id: '1', stage: 'won' })
  })

  it('denylist includes leads PII columns', () => {
    expect(SENSITIVE_COLUMNS.leads).toEqual(
      expect.arrayContaining(['email', 'phone', 'date_of_birth', 'insurance_id'])
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/audit/__tests__/redaction.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/audit/redaction.ts
// Columns whose values must never be snapshotted into audit_events.
// MIRRORED in supabase/migrations/20260704160000_audit_events.sql (audit_row_change).
// Keep the two in sync.
export const SENSITIVE_COLUMNS: Record<string, string[]> = {
  leads: ['email', 'phone', 'date_of_birth', 'insurance_id', 'phone_hash', 'email_hash'],
  patient_profiles: ['personal_details'],
  clinical_cases: ['patient_email', 'patient_phone'],
}

export function redactRow(
  table: string,
  row: Record<string, unknown>
): Record<string, unknown> {
  const denied = SENSITIVE_COLUMNS[table]
  if (!denied) return row
  const out: Record<string, unknown> = { ...row }
  for (const col of denied) {
    if (col in out) out[col] = '[redacted]'
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/audit/__tests__/redaction.test.ts`
Expected: PASS (4 tests).

> NOTE: In Task 7, confirm the actual PII column names on `leads`/`clinical_cases`
> in `src/types/database.ts` and adjust both this denylist and the SQL copy to
> match. If `clinical_cases`/`patient_profiles` columns differ, fix here before Phase 2.

- [ ] **Step 5: Commit**

```bash
git add src/lib/audit/redaction.ts src/lib/audit/__tests__/redaction.test.ts
git commit -m "feat(audit): sensitive-column redaction"
```

---

## Phase 2 — Storage migration

### Task 4: Create `audit_events` table, RLS, append-only WORM

**Files:**
- Create: `supabase/migrations/20260704160000_audit_events.sql`

- [ ] **Step 1: Write the migration (table + indexes + RLS + append-only)**

```sql
-- supabase/migrations/20260704160000_audit_events.sql
-- Universal, append-only audit trail (human + AI). See
-- docs/superpowers/specs/2026-07-04-full-audit-trail-design.md.

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('user','system','ai_agent','cron','webhook')),
  actor_id uuid,
  actor_label text,
  action text not null,
  resource_type text,
  resource_id text,
  source text not null check (source in ('db_trigger','api_route','cron','webhook')),
  before jsonb,
  after jsonb,
  changed_fields text[],
  ai jsonb,
  request_id text,
  ip text,
  user_agent text,
  severity text not null default 'info' check (severity in ('info','warning','critical')),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_audit_events_org_time
  on public.audit_events (organization_id, occurred_at desc);
create index if not exists idx_audit_events_resource
  on public.audit_events (organization_id, resource_type, resource_id, occurred_at desc);
create index if not exists idx_audit_events_actor
  on public.audit_events (organization_id, actor_type, occurred_at desc);
create index if not exists idx_audit_events_action
  on public.audit_events (organization_id, action);

alter table public.audit_events enable row level security;

-- Read own org; insert own org (authenticated paths). No UPDATE/DELETE policy.
create policy "audit_events_org_select" on public.audit_events
  for select using (organization_id = public.get_user_org_id());
create policy "audit_events_org_insert" on public.audit_events
  for insert with check (organization_id = public.get_user_org_id());
create policy "audit_events_service_insert" on public.audit_events
  for insert to service_role with check (true);

-- Append-only: reuse the existing WORM trigger (blocks UPDATE/DELETE incl. service role).
drop trigger if exists trg_audit_events_append_only on public.audit_events;
create trigger trg_audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function public.prevent_row_mutation();
```

- [ ] **Step 2: Apply to the linked DB**

Run: `supabase db query --linked -f supabase/migrations/20260704160000_audit_events.sql`
Expected: `CREATE TABLE` / `CREATE INDEX` / `CREATE POLICY` / `CREATE TRIGGER`, no errors.

- [ ] **Step 3: Verify append-only + shape (SQL smoke)**

Run this against the linked DB (via `supabase db query --linked -f -` or the SQL editor):

```sql
-- expect: one row inserts fine
insert into public.audit_events (organization_id, actor_type, action, source)
select id, 'system', 'audit.selftest', 'api_route' from public.organizations limit 1;

-- expect: ERROR "append-only — UPDATE is not permitted"
update public.audit_events set action = 'x' where action = 'audit.selftest';

-- expect: ERROR "append-only — DELETE is not permitted"
delete from public.audit_events where action = 'audit.selftest';
```

Expected: insert succeeds; UPDATE and DELETE both raise `check_violation`. (The self-test row stays — that is correct for an append-only table.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260704160000_audit_events.sql
git commit -m "feat(audit): append-only audit_events table + RLS"
```

---

## Phase 3 — DB trigger capture + actor plumbing

### Task 5: Actor GUC helper `withAuditActor`

**Files:**
- Create: `src/lib/audit/actor.ts`
- Test: `src/lib/audit/__tests__/actor.test.ts`

- [ ] **Step 1: Write the failing test** (mock supabase captures the `set_config` RPC args)

```typescript
// src/lib/audit/__tests__/actor.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildActorGucArgs } from '@/lib/audit/actor'

describe('buildActorGucArgs', () => {
  it('maps actor fields to app.* GUC key/value pairs', () => {
    const args = buildActorGucArgs({
      actorType: 'ai_agent',
      actorId: 'agent-1',
      actorLabel: 'AI Closer',
      requestId: 'req-9',
    })
    expect(args).toContainEqual({ key: 'app.actor_type', value: 'ai_agent' })
    expect(args).toContainEqual({ key: 'app.actor_id', value: 'agent-1' })
    expect(args).toContainEqual({ key: 'app.actor_label', value: 'AI Closer' })
    expect(args).toContainEqual({ key: 'app.request_id', value: 'req-9' })
  })

  it('omits GUCs for missing fields (no empty-string identity)', () => {
    const args = buildActorGucArgs({ actorType: 'system' })
    expect(args).toEqual([{ key: 'app.actor_type', value: 'system' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/audit/__tests__/actor.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write implementation**

```typescript
// src/lib/audit/actor.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuditActor } from '@/lib/audit/types'

export function buildActorGucArgs(actor: AuditActor): { key: string; value: string }[] {
  const pairs: { key: string; value: string }[] = [
    { key: 'app.actor_type', value: actor.actorType },
  ]
  if (actor.actorId) pairs.push({ key: 'app.actor_id', value: actor.actorId })
  if (actor.actorLabel) pairs.push({ key: 'app.actor_label', value: actor.actorLabel })
  if (actor.requestId) pairs.push({ key: 'app.request_id', value: actor.requestId })
  return pairs
}

/**
 * Sets Postgres session GUCs so audit triggers can attribute writes made
 * through this client to the given actor. Call once per request/transaction
 * before performing audited mutations. is_local=false so the setting persists
 * for the connection's session (pooled), scoped by the following statements.
 */
export async function withAuditActor(
  client: SupabaseClient,
  actor: AuditActor
): Promise<void> {
  for (const { key, value } of buildActorGucArgs(actor)) {
    await client.rpc('set_audit_config', { setting_key: key, setting_value: value })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/audit/__tests__/actor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/audit/actor.ts src/lib/audit/__tests__/actor.test.ts
git commit -m "feat(audit): actor GUC plumbing helper"
```

---

### Task 6: `set_audit_config` RPC (SQL)

**Files:**
- Modify: `supabase/migrations/20260704160000_audit_events.sql` (append)

A `SECURITY DEFINER` function is required because PostgREST cannot call
`set_config` directly. It only accepts the `app.*` namespace.

- [ ] **Step 1: Append the function**

```sql
-- set_audit_config: allow the app to set app.* session GUCs for trigger attribution.
create or replace function public.set_audit_config(setting_key text, setting_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if setting_key not like 'app.%' then
    raise exception 'set_audit_config only accepts app.* keys, got %', setting_key;
  end if;
  perform set_config(setting_key, setting_value, false);
end;
$$;

grant execute on function public.set_audit_config(text, text) to authenticated, service_role;
```

- [ ] **Step 2: Apply**

Run: `supabase db query --linked -f supabase/migrations/20260704160000_audit_events.sql`
Expected: `CREATE FUNCTION` / `GRANT`, no errors (rest is idempotent via `if not exists` / `or replace`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260704160000_audit_events.sql
git commit -m "feat(audit): set_audit_config RPC for GUC attribution"
```

---

### Task 7: `audit_row_change()` trigger function + attach to curated tables

**Files:**
- Modify: `supabase/migrations/20260704160000_audit_events.sql` (append)

- [ ] **Step 1: Confirm PII column names**

Run: `grep -nE "email|phone|date_of_birth|insurance" src/types/database.ts | grep -i "leads\|clinical_cases" | head`
Adjust the `denylist` CASE below AND `SENSITIVE_COLUMNS` in `redaction.ts` to the real column names before applying.

- [ ] **Step 2: Append the trigger function**

```sql
-- Generic row-change auditor. Total function: never raises, so it can never
-- roll back the business transaction. Resolves actor from app.* GUCs set by
-- set_audit_config(); falls back to auth.uid() then 'system'.
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
  v_actor_type text;
  v_actor_id text;
  v_denylist text[];
  v_col text;
begin
  begin
    -- org id: prefer NEW, else OLD
    v_org := coalesce(
      (to_jsonb(NEW) ->> 'organization_id'),
      (to_jsonb(OLD) ->> 'organization_id')
    )::uuid;
    if v_org is null then
      return coalesce(NEW, OLD);
    end if;

    v_before := case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end;
    v_after  := case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end;

    -- Redaction denylist per table (MIRROR of src/lib/audit/redaction.ts).
    v_denylist := case TG_TABLE_NAME
      when 'leads' then array['email','phone','date_of_birth','insurance_id','phone_hash','email_hash']
      when 'clinical_cases' then array['patient_email','patient_phone']
      when 'patient_profiles' then array['personal_details']
      else array[]::text[]
    end;
    foreach v_col in array v_denylist loop
      if v_before ? v_col then v_before := jsonb_set(v_before, array[v_col], '"[redacted]"'::jsonb); end if;
      if v_after  ? v_col then v_after  := jsonb_set(v_after,  array[v_col], '"[redacted]"'::jsonb); end if;
    end loop;

    -- changed fields (top-level keys whose value differs)
    if v_before is not null and v_after is not null then
      select array_agg(key) into v_changed
      from (
        select key from jsonb_object_keys(v_before || v_after) as t(key)
      ) k
      where (v_before -> k.key) is distinct from (v_after -> k.key);
    end if;

    v_actor_type := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system');
    v_actor_id := nullif(current_setting('app.actor_id', true), '');
    if v_actor_id is null and auth.uid() is not null then
      v_actor_type := 'user';
      v_actor_id := auth.uid()::text;
    end if;

    insert into public.audit_events (
      organization_id, actor_type, actor_id, actor_label, action,
      resource_type, resource_id, source, before, after, changed_fields,
      request_id
    ) values (
      v_org,
      v_actor_type,
      case when v_actor_id ~ '^[0-9a-f-]{36}$' then v_actor_id::uuid else null end,
      nullif(current_setting('app.actor_label', true), ''),
      TG_TABLE_NAME || '.' || lower(TG_OP),
      TG_TABLE_NAME,
      coalesce((to_jsonb(NEW) ->> 'id'), (to_jsonb(OLD) ->> 'id')),
      'db_trigger',
      v_before, v_after, v_changed,
      nullif(current_setting('app.request_id', true), '')
    );
  exception when others then
    -- Never break the business transaction because auditing failed.
    raise warning 'audit_row_change failed for %.%: %', TG_TABLE_SCHEMA, TG_TABLE_NAME, sqlerrm;
  end;
  return coalesce(NEW, OLD);
end;
$$;
```

- [ ] **Step 3: Attach to curated tables**

```sql
-- Attach to the v1 curated set. Add tables here as coverage expands.
do $$
declare t text;
begin
  foreach t in array array['leads','appointments','clinical_cases','user_profiles','connector_configs'] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('drop trigger if exists trg_audit_%1$s on public.%1$I', t);
      execute format(
        'create trigger trg_audit_%1$s after insert or update or delete on public.%1$I
         for each row execute function public.audit_row_change()', t);
    end if;
  end loop;
end $$;
```

- [ ] **Step 4: Apply**

Run: `supabase db query --linked -f supabase/migrations/20260704160000_audit_events.sql`
Expected: `CREATE FUNCTION`, `DO`, no errors.

- [ ] **Step 5: Integration smoke — direct UPDATE produces an audit row**

Run against the linked DB (proves trigger coverage independent of the app):

```sql
-- pick a real lead
with target as (select id, organization_id, stage_id from public.leads limit 1)
select public.set_audit_config('app.actor_type','system');
-- perform a harmless no-op-ish update (set stage_id to itself)
update public.leads l set updated_at = now()
from target where l.id = target.id;

-- expect: a fresh row
select action, actor_type, source, changed_fields
from public.audit_events
where resource_type = 'leads' order by occurred_at desc limit 1;
```

Expected: one `leads.update` row, `source='db_trigger'`. Confirm no `email`/`phone` plaintext appears in `before`/`after` (should be `"[redacted]"`).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260704160000_audit_events.sql
git commit -m "feat(audit): row-change trigger + attach to curated tables"
```

---

## Phase 4 — App helper

### Task 8: `recordAudit` + actor resolution

**Files:**
- Create: `src/lib/audit/record.ts`
- Test: `src/lib/audit/__tests__/record.test.ts`

- [ ] **Step 1: Write the failing test** (mock supabase; assert insert payload + never-throws)

```typescript
// src/lib/audit/__tests__/record.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildAuditRow } from '@/lib/audit/record'

describe('buildAuditRow', () => {
  it('maps an AuditEventInput to the audit_events insert shape', () => {
    const row = buildAuditRow({
      organizationId: 'org-1',
      action: 'sms.sent',
      actor: { actorType: 'ai_agent', actorId: 'agent-1', actorLabel: 'AI Setter' },
      source: 'api_route',
      resourceType: 'lead',
      resourceId: 'lead-9',
      ai: { autonomous: true, agent_role: 'setter', model: 'claude-sonnet-5' },
    })
    expect(row).toMatchObject({
      organization_id: 'org-1',
      action: 'sms.sent',
      actor_type: 'ai_agent',
      actor_id: 'agent-1',
      actor_label: 'AI Setter',
      source: 'api_route',
      resource_type: 'lead',
      resource_id: 'lead-9',
      severity: 'info',
    })
    expect(row.ai).toMatchObject({ autonomous: true, agent_role: 'setter' })
    expect(row.metadata).toEqual({})
  })

  it('defaults severity to info and metadata to {}', () => {
    const row = buildAuditRow({
      organizationId: 'o', action: 'a',
      actor: { actorType: 'system' }, source: 'cron',
    })
    expect(row.severity).toBe('info')
    expect(row.metadata).toEqual({})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/audit/__tests__/record.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write implementation**

```typescript
// src/lib/audit/record.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuditEventInput } from '@/lib/audit/types'

export function buildAuditRow(event: AuditEventInput) {
  return {
    organization_id: event.organizationId,
    action: event.action,
    actor_type: event.actor.actorType,
    actor_id: event.actor.actorId ?? null,
    actor_label: event.actor.actorLabel ?? null,
    source: event.source,
    resource_type: event.resourceType ?? null,
    resource_id: event.resourceId ?? null,
    before: event.before ?? null,
    after: event.after ?? null,
    changed_fields: event.changedFields ?? null,
    ai: event.ai ?? null,
    request_id: event.actor.requestId ?? null,
    severity: event.severity ?? 'info',
    metadata: event.metadata ?? {},
  }
}

/**
 * Records an audit event. NEVER throws into the caller — a failure to audit
 * must not break the business action. Mirrors the hipaa-audit.ts fallback.
 */
export async function recordAudit(
  supabase: SupabaseClient,
  event: AuditEventInput
): Promise<void> {
  try {
    const { error } = await supabase.from('audit_events').insert(buildAuditRow(event))
    if (error) throw error
  } catch (err) {
    console.error(
      `[AUDIT_FAILURE] Failed to record ${event.action} for ` +
      `${event.resourceType ?? '?'}:${event.resourceId ?? '?'}. ` +
      `Error: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/audit/__tests__/record.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/audit/record.ts src/lib/audit/__tests__/record.test.ts
git commit -m "feat(audit): recordAudit helper (never-throws)"
```

---

## Phase 5 — AI instrumentation

### Task 9: Instrument the three autonomous action sites

**Files (locate exact lines first):**
- Modify: autopilot SMS send site
- Modify: mass-send site
- Modify: voice agent action site

- [ ] **Step 1: Locate the sites**

Run:
```bash
grep -rnE "autopilot|autonomous" src/lib/messaging src/lib/ai src/app/api | grep -iE "send|sms" | head
grep -rnE "mass|bulk" src/app/api/leads/bulk src/lib/messaging 2>/dev/null | head
grep -rn "recordAudit\|logHIPAAEvent" src/lib/voice | head
```
Record the exact file:line for each. Each becomes its own commit below.

- [ ] **Step 2: Add a `recordAudit` call at each site (autopilot SMS example)**

At the point where an autopilot SMS is actually dispatched, after resolving `orgId`, `leadId`, and the model, add:

```typescript
import { recordAudit } from '@/lib/audit/record'

await recordAudit(serviceClient, {
  organizationId: orgId,
  action: 'sms.sent',
  actor: { actorType: 'ai_agent', actorId: agentId ?? null, actorLabel: 'AI Setter' },
  source: 'api_route',
  resourceType: 'lead',
  resourceId: leadId,
  ai: {
    autonomous: true,
    agent_role: 'setter',
    model: modelId,
    approved_by: approvedByUserId ?? null,
    gate: 'autopilot_gate',
  },
  metadata: { channel: 'sms' },
})
```

Repeat for mass-send (`action: 'sms.mass_sent'` / `'email.mass_sent'`, `agent_role` per campaign type, `autonomous` per whether a human clicked send → set `approved_by`) and voice (`action: 'call.placed'`, `agent_role: 'voice'`).

- [ ] **Step 3: Typecheck + full test run**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 4: Commit each site separately**

```bash
git add <autopilot file> && git commit -m "feat(audit): record autonomous autopilot SMS"
git add <mass-send file> && git commit -m "feat(audit): record mass-send actions"
git add <voice file> && git commit -m "feat(audit): record AI voice call placement"
```

---

### Task 10: Set actor GUCs on authenticated mutating routes

**Files:**
- Modify: a shared server entrypoint used by mutating API routes (identify in Step 1).

- [ ] **Step 1: Find where routes resolve the user + service client**

Run: `grep -rn "createServiceClient\|resolveActiveOrg" src/app/api | grep -iE "leads|stage|appointments" | head`
Pick 2-3 high-value mutating routes (lead update, stage move, appointment write) for v1 attribution. (Full coverage is incremental — the trigger still logs `system` for un-wrapped routes.)

- [ ] **Step 2: Call `withAuditActor` before the mutation**

In each chosen route, after resolving the profile and before the service-client write:

```typescript
import { withAuditActor } from '@/lib/audit/actor'

await withAuditActor(serviceClient, {
  actorType: 'user',
  actorId: profile.id,
  actorLabel: profile.email ?? profile.full_name ?? null,
  requestId: request.headers.get('x-request-id') ?? null,
})
// ... existing service-client mutation follows; the trigger now attributes it to this user
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Manual verify**

Perform a lead edit through the app, then:
```sql
select action, actor_type, actor_id, actor_label from public.audit_events
where resource_type='leads' order by occurred_at desc limit 1;
```
Expected: `actor_type='user'` with the editor's id/email (not `system`).

- [ ] **Step 5: Commit**

```bash
git add <routes> && git commit -m "feat(audit): attribute mutating routes to the acting user"
```

---

## Phase 6 — Query + API

### Task 11: Timeline normalization (pure) + fetch

**Files:**
- Create: `src/lib/audit/query.ts`
- Test: `src/lib/audit/__tests__/query.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/audit/__tests__/query.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeTimeline } from '@/lib/audit/query'

describe('normalizeTimeline', () => {
  it('merges audit_events and hipaa rows, newest first', () => {
    const audit = [{
      id: 'a1', occurred_at: '2026-07-04T10:00:00Z', actor_type: 'ai_agent',
      actor_label: 'AI Closer', action: 'sms.sent', resource_type: 'lead',
      resource_id: 'l1', changed_fields: null, ai: { autonomous: true },
      severity: 'info',
    }]
    const hipaa = [{
      id: 'h1', created_at: '2026-07-04T11:00:00Z', actor_type: 'user',
      actor_id: 'u1', event_type: 'phi_access', resource_type: 'lead',
      resource_id: 'l1', severity: 'info', description: 'viewed',
    }]
    const rows = normalizeTimeline(audit as any, hipaa as any)
    expect(rows.map(r => r.id)).toEqual(['h1', 'a1']) // newest first
    expect(rows[0].origin).toBe('hipaa_audit_log')
    expect(rows[1].origin).toBe('audit_events')
    expect(rows[1].changedFields).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/audit/__tests__/query.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write implementation**

```typescript
// src/lib/audit/query.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TimelineRow, ActorType } from '@/lib/audit/types'

export function normalizeTimeline(
  auditRows: any[],
  hipaaRows: any[]
): TimelineRow[] {
  const a: TimelineRow[] = (auditRows ?? []).map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    actorType: r.actor_type as ActorType,
    actorLabel: r.actor_label ?? null,
    action: r.action,
    resourceType: r.resource_type ?? null,
    resourceId: r.resource_id ?? null,
    changedFields: r.changed_fields ?? [],
    ai: r.ai ?? null,
    severity: r.severity ?? 'info',
    origin: 'audit_events',
  }))
  const h: TimelineRow[] = (hipaaRows ?? []).map((r) => ({
    id: r.id,
    occurredAt: r.created_at,
    actorType: r.actor_type as ActorType,
    actorLabel: r.actor_id ?? null,
    action: r.event_type,
    resourceType: r.resource_type ?? null,
    resourceId: r.resource_id ?? null,
    changedFields: [],
    ai: null,
    severity: r.severity ?? 'info',
    origin: 'hipaa_audit_log',
  }))
  return [...a, ...h].sort((x, y) => (x.occurredAt < y.occurredAt ? 1 : -1))
}

export type AuditFilter = {
  resourceType?: string
  resourceId?: string
  actorType?: ActorType
  action?: string
  since?: string
  limit?: number
}

export async function fetchAuditTimeline(
  supabase: SupabaseClient,
  organizationId: string,
  filter: AuditFilter = {}
): Promise<TimelineRow[]> {
  const limit = Math.min(filter.limit ?? 100, 500)
  let aq = supabase
    .from('audit_events')
    .select('id,occurred_at,actor_type,actor_label,action,resource_type,resource_id,changed_fields,ai,severity')
    .eq('organization_id', organizationId)
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (filter.resourceType) aq = aq.eq('resource_type', filter.resourceType)
  if (filter.resourceId) aq = aq.eq('resource_id', filter.resourceId)
  if (filter.actorType) aq = aq.eq('actor_type', filter.actorType)
  if (filter.action) aq = aq.eq('action', filter.action)
  if (filter.since) aq = aq.gte('occurred_at', filter.since)

  let hq = supabase
    .from('hipaa_audit_log')
    .select('id,created_at,actor_type,actor_id,event_type,resource_type,resource_id,severity,description')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (filter.resourceType) hq = hq.eq('resource_type', filter.resourceType)
  if (filter.resourceId) hq = hq.eq('resource_id', filter.resourceId)

  const [{ data: audit }, { data: hipaa }] = await Promise.all([aq, hq])
  return normalizeTimeline(audit ?? [], hipaa ?? []).slice(0, limit)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/audit/__tests__/query.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/audit/query.ts src/lib/audit/__tests__/query.test.ts
git commit -m "feat(audit): timeline union + fetch"
```

---

### Task 12: `GET /api/audit`

**Files:**
- Create: `src/app/api/audit/route.ts`

- [ ] **Step 1: Read a sibling route for the current App Router handler signature**

Run: `sed -n '1,40p' src/app/api/leads/route.ts`
(Match its `createClient`, auth, and `NextResponse` patterns — Next.js 16; do not copy from memory. See `node_modules/next/dist/docs/` if unsure.)

- [ ] **Step 2: Write the route**

```typescript
// src/app/api/audit/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveActiveOrg } from '@/lib/auth/active-org'
import { fetchAuditTimeline, type AuditFilter } from '@/lib/audit/query'
import type { ActorType } from '@/lib/audit/types'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const active = await resolveActiveOrg(supabase)
  if (!active?.organizationId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const sp = request.nextUrl.searchParams
  const filter: AuditFilter = {
    resourceType: sp.get('resourceType') ?? undefined,
    resourceId: sp.get('resourceId') ?? undefined,
    actorType: (sp.get('actorType') as ActorType) ?? undefined,
    action: sp.get('action') ?? undefined,
    since: sp.get('since') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : undefined,
  }
  const rows = await fetchAuditTimeline(supabase, active.organizationId, filter)
  return NextResponse.json({ rows })
}
```

> NOTE: In Step 1 confirm the real shape of `resolveActiveOrg`'s return (it may be `{ organization_id }` not `{ organizationId }`). Adjust accordingly — this is the one spot most likely to drift from the codebase.

- [ ] **Step 3: Typecheck + verify**

Run: `npx tsc --noEmit`
Then with the dev server: `curl -s "http://localhost:3000/api/audit?limit=5"` while authenticated (or verify via the preview tools).
Expected: 200 with `{ rows: [...] }`, org-scoped.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/audit/route.ts
git commit -m "feat(audit): GET /api/audit timeline endpoint"
```

---

## Phase 7 — UI surface

### Task 13: `AuditTimeline` component

**Files:**
- Create: `src/components/audit/AuditTimeline.tsx`

- [ ] **Step 1: Read an existing timeline/list component for style**

Run: `grep -rln "timeline\|Timeline" src/components | head`
Match existing Tailwind/shadcn conventions (badge, relative time). Do not introduce a new styling system.

- [ ] **Step 2: Write the component**

```tsx
// src/components/audit/AuditTimeline.tsx
'use client'
import { useEffect, useState } from 'react'
import type { TimelineRow } from '@/lib/audit/types'

const actorBadge: Record<string, string> = {
  user: 'bg-blue-100 text-blue-800',
  ai_agent: 'bg-purple-100 text-purple-800',
  system: 'bg-gray-100 text-gray-700',
  cron: 'bg-amber-100 text-amber-800',
  webhook: 'bg-teal-100 text-teal-800',
}

export function AuditTimeline({ query }: { query?: string }) {
  const [rows, setRows] = useState<TimelineRow[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    setLoading(true)
    fetch(`/api/audit?${query ?? ''}`)
      .then((r) => r.json())
      .then((d) => setRows(d.rows ?? []))
      .finally(() => setLoading(false))
  }, [query])

  if (loading) return <div className="text-sm text-muted-foreground">Loading audit trail…</div>
  if (!rows.length) return <div className="text-sm text-muted-foreground">No recorded actions.</div>

  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={`${r.origin}:${r.id}`} className="flex items-start gap-3 rounded-md border p-2 text-sm">
          <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${actorBadge[r.actorType] ?? actorBadge.system}`}>
            {r.actorType === 'ai_agent' ? (r.ai?.agent_role ? `AI ${r.ai.agent_role}` : 'AI') : r.actorType}
          </span>
          <div className="flex-1">
            <div className="font-medium">{r.action}</div>
            <div className="text-xs text-muted-foreground">
              {r.actorLabel ?? '—'}
              {r.changedFields.length > 0 && <> · changed: {r.changedFields.join(', ')}</>}
              {r.ai?.autonomous === false && r.ai?.approved_by && <> · approved by {r.ai.approved_by}</>}
              {r.ai?.autonomous === true && <> · autonomous</>}
            </div>
          </div>
          <time className="text-xs text-muted-foreground">{new Date(r.occurredAt).toLocaleString()}</time>
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/audit/AuditTimeline.tsx
git commit -m "feat(audit): AuditTimeline component"
```

---

### Task 14: Embed on lead detail + new `/audit` page

**Files:**
- Modify: lead detail component (locate in Step 1)
- Create: `src/app/(dashboard)/audit/page.tsx`

- [ ] **Step 1: Locate the lead detail component**

Run: `grep -rln "lead" src/components/crm | grep -i "detail" | head`
Add a "Full history" section rendering `<AuditTimeline query={`resourceType=leads&resourceId=${lead.id}`} />`.

- [ ] **Step 2: Create the agency `/audit` page**

```tsx
// src/app/(dashboard)/audit/page.tsx
import { AuditTimeline } from '@/components/audit/AuditTimeline'

export default function AuditPage() {
  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-xl font-semibold">Audit trail</h1>
        <p className="text-sm text-muted-foreground">
          Every action taken in this workspace — by staff and by AI.
        </p>
      </div>
      <AuditTimeline query="limit=200" />
    </div>
  )
}
```

- [ ] **Step 3: Verify in the browser (preview tools)**

Start the dev server, navigate to `/audit`, and confirm rows render with correct actor badges. On a lead detail page confirm the "Full history" section loads.
Expected: timeline visible, AI actions badged distinctly from human actions.

- [ ] **Step 4: Typecheck, full test run, build**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/audit/page.tsx src/components/crm
git commit -m "feat(audit): /audit page + lead-detail full-history timeline"
```

---

## Phase 8 — SQL smoke doc + wrap-up

### Task 15: Record the SQL smoke checks + final verification

**Files:**
- Create: `docs/superpowers/plans/audit-sql-smoke.md`

- [ ] **Step 1: Write the smoke doc** (copy the SQL blocks from Tasks 4 and 7 — append-only enforcement, direct-update coverage, redaction check, and an RLS cross-org check):

```sql
-- RLS cross-org check: as org A's JWT, selecting org B's rows must return 0.
-- Run in the SQL editor authenticated as an org-A user, or via a scoped client.
select count(*) from public.audit_events
where organization_id <> public.get_user_org_id();  -- expect 0
```

- [ ] **Step 2: Run the full smoke suite** against the linked DB and check each expectation off in the doc.

- [ ] **Step 3: Final gate**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: all green.

- [ ] **Step 4: Commit + open PR**

```bash
git add docs/superpowers/plans/audit-sql-smoke.md
git commit -m "docs(audit): SQL smoke verification checklist"
git push -u origin feat/full-audit-trail
gh pr create --title "feat: full audit trail (human + AI)" \
  --body "Universal append-only audit trail. Implements docs/superpowers/specs/2026-07-04-full-audit-trail-design.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-review notes

- **Spec coverage:** storage (T4), append-only WORM (T4), hybrid capture — triggers (T7) + helper (T8), actor plumbing (T5/T6/T10), AI attribution/no-prompt (T9), redaction (T3/T7), query+API (T11/T12), UI timeline + `/audit` (T13/T14), testing incl. trigger-coverage + append-only + RLS (T4/T7/T15). PHI reads left in `hipaa_audit_log`, unioned in T11.
- **Known drift points to verify during execution (flagged inline):** real PII column names on `leads`/`clinical_cases` (T7 Step 1); `resolveActiveOrg` return shape (T12); exact AI action-site files (T9 Step 1); Next.js 16 route handler signature (T12 Step 1). These are codebase facts to confirm, not placeholders.
- **Type consistency:** `AuditActor`, `AuditEventInput`, `TimelineRow`, `AiContext` defined in T1 and used unchanged in T5/T8/T11/T13. `set_audit_config` (T6) is the RPC `withAuditActor` (T5) calls. `audit_row_change` denylist (T7) mirrors `SENSITIVE_COLUMNS` (T3).
