# Full Audit Trail (Human + AI) — Design

**Date:** 2026-07-04
**Status:** Approved (design), pending implementation plan
**Author:** Amin Samadian (with Claude)

## Problem

Lead Intelligence needs a full, tamper-evident audit trail covering **all
consequential actions taken in the app — by humans and by AI agents alike**.

Today the codebase has a tamper-evident spine but it is aimed narrowly at PHI:

- `hipaa_audit_log` — append-only (WORM) via `prevent_row_mutation()` trigger
  (blocks UPDATE/DELETE even for the `service_role`), SELECT/INSERT-only RLS.
  Already models `actor_type IN ('user','system','ai_agent','cron','webhook')`,
  `resource_type`, `resource_id`, `severity`, `metadata` jsonb.
- `consent_log` — same append-only treatment (TCPA).
- `lead_activities` — business-facing activity feed (not a security log).
- `src/lib/ai/hipaa.ts::logHIPAAEvent` + `src/lib/hipaa-audit.ts` — helpers,
  scoped to PHI access only.

The gap: there is no **universal** record of *who/what changed which record,
before → after, and why*, spanning humans, AI agents, crons, and webhooks.

## Goals (drivers, all in scope)

1. **Compliance / legal defensibility** — HIPAA, TCPA, SOC 2, Series A DD.
   WORM immutability, actor attribution, long retention.
2. **AI accountability** — prove what AI (setter / closer / autopilot / voice)
   did autonomously vs. what a human approved.
3. **Operational forensics** — reconstruct a record's full history; before/after
   diffs across all actor types.
4. **Customer / admin transparency** — readable activity timeline in the UI.

## Scope decisions (locked during brainstorming)

- **Action scope:** mutations (create/update/delete/state-change) by any actor,
  **plus** the PHI/PII reads already logged for HIPAA. Ordinary list/page views
  are **out of scope** (volume/cost).
- **Capture mechanism:** **hybrid** — DB triggers for guaranteed coverage +
  an app-layer helper for rich context.
- **AI detail level:** attribution + decision metadata (model, agent role,
  autonomous-vs-approved, approving user, authorizing gate/confidence).
  **No raw prompt/response text** — avoids widening the PHI breach surface.

## Non-goals (v1)

- Logging ordinary reads / page views.
- Storing raw AI prompt/response text.
- External WORM sink (Datadog / S3 Object Lock) — noted as a future export.
- Monthly partitioning / archival — deferred (YAGNI until volume warrants).

## Architecture

### Two-table split

- `hipaa_audit_log` stays the **system-of-record for PHI reads** (keeps
  breach-scope queries a single-table scan; does not grow the PHI surface).
- **New `audit_events`** table is the **universal trail**: mutations, outbound
  comms, AI decisions, auth/admin changes.
- The transparency UI **unions** both views for a complete timeline.

### 1. Storage — `public.audit_events` (append-only)

Reuses the existing `public.prevent_row_mutation()` trigger, SELECT/INSERT-only
RLS, and an explicit `service_role` INSERT policy — identical hardening to
`hipaa_audit_log`, so it is tamper-evident against the service role too.

Columns:

| column            | type        | notes |
|-------------------|-------------|-------|
| `id`              | uuid pk     | `gen_random_uuid()` |
| `organization_id` | uuid        | FK, RLS scope |
| `occurred_at`     | timestamptz | default `now()` |
| `actor_type`      | text        | `user\|system\|ai_agent\|cron\|webhook` (checked) |
| `actor_id`        | uuid null   | user id / agent id where known |
| `actor_label`     | text null   | denormalized display (e.g. "AI Closer", email) |
| `action`          | text        | verb, e.g. `lead.stage_changed`, `sms.sent` |
| `resource_type`   | text null   | e.g. `lead`, `appointment`, `contract` |
| `resource_id`     | text null   | |
| `source`          | text        | `db_trigger\|api_route\|cron\|webhook` |
| `before`          | jsonb null  | prior row (trigger-captured) |
| `after`           | jsonb null  | new row (trigger-captured) |
| `changed_fields`  | text[] null | keys that differ between before/after |
| `ai`              | jsonb null  | `{model, agent_role, autonomous, approved_by, gate, confidence}` — no prompt text |
| `request_id`      | text null   | correlate rows from one HTTP request |
| `ip`              | text null   | |
| `user_agent`      | text null   | |
| `severity`        | text        | `info\|warning\|critical`, default `info` |
| `metadata`        | jsonb       | default `{}` |

Indexes: `(organization_id, occurred_at desc)`, `(organization_id, resource_type, resource_id, occurred_at desc)`, `(organization_id, actor_type, occurred_at desc)`, `(organization_id, action)`.

Sensitive columns in `before`/`after` (encrypted PII, hashes) are redacted by
the trigger to a `"[redacted]"` sentinel via a per-table column denylist, so the
audit log never re-exposes plaintext the base table itself encrypts.

### 2. Capture — hybrid

**a. DB triggers — `public.audit_row_change()`**
`AFTER INSERT OR UPDATE OR DELETE` on a curated set of tables. Computes
`before`/`after`/`changed_fields`; resolves actor from session GUCs (below);
writes one `audit_events` row with `source='db_trigger'`. **Cannot be bypassed**
— even a direct SQL `UPDATE` lands a row. This is the completeness guarantee.

Curated table list (v1):
`leads`, `appointments`, `clinical_cases` (contracts), `user_profiles`,
`connector_configs`, campaign/message tables. Consent stays in `consent_log`;
PHI reads stay in `hipaa_audit_log` — not duplicated here.

**b. App helper — `src/lib/audit/record.ts::recordAudit(ctx, event)`**
For events triggers can't see well: outbound SMS/email/call, AI decisions,
logins/permission changes. Rich context; `source='api_route'|'cron'|'webhook'`.
Never throws into the caller — failures are caught and routed to the same
alerting fallback pattern as `hipaa-audit.ts`.

### 3. Actor plumbing (identity into triggers)

Writes go through the `service_role`, so `auth.uid()` is null inside triggers.
`src/lib/audit/actor.ts::withAuditActor(client, actor)` sets Postgres session
GUCs at the start of a request/transaction:

- `app.actor_id`, `app.actor_type`, `app.actor_label`, `app.request_id`,
  `app.ai_context` (JSON) — via `select set_config('app.actor_type', $1, true)`.

`audit_row_change()` reads them with `current_setting('app.actor_type', true)`,
falling back to `auth.uid()` then `'system'`. This is what makes
trigger-captured rows attributable to a specific human, AI agent, cron, or
webhook rather than an anonymous service-role write.

### 4. AI accountability

At the autonomous action sites — voice agent (`src/lib/voice/*`), autopilot SMS,
and mass-send — `recordAudit` populates `ai` with `model`, `agent_role`
(`setter|closer|autopilot|voice`), `autonomous` (bool), `approved_by` (user id
or null), and `gate`/`confidence` that authorized the action. No raw prompt.

### 5. Surfacing (transparency)

- `src/lib/audit/query.ts` — org-scoped query helpers (union `audit_events`
  + `hipaa_audit_log`, normalized to a common timeline row shape).
- `GET /api/audit` — filters: actor type, action, resource, date range; RLS-
  scoped via `resolveActiveOrg`.
- `AuditTimeline` component — embedded on lead detail ("full history") and a new
  agency-level `/audit` page. Admin `/audit` page confirmed **in scope for v1**.

### 6. Retention

In-DB, append-only, retained indefinitely for compliance. Monthly partitioning /
archival + external WORM export are future work.

## Error handling

- `recordAudit` never propagates errors to the business path; on failure it logs
  a `[AUDIT_FAILURE]` line (same pattern as `hipaa-audit.ts`) for alerting.
- Trigger failures must **not** silently drop: `audit_row_change()` is written to
  be total (safe defaults for every field) so it cannot raise and roll back the
  business transaction. Any internal error is swallowed to a minimal fallback row.
- Append-only trigger stays the hard backstop; no code path updates/deletes
  `audit_events`.

## Testing

- Unit: diff / `changed_fields` computation; column redaction denylist;
  `recordAudit` actor resolution; timeline normalization/union.
- Integration: an **un-instrumented direct `UPDATE`** on an audited table still
  produces an `audit_events` row (proves trigger coverage independent of app).
- Security: append-only enforcement (UPDATE/DELETE raises for service role);
  RLS scoping (org A cannot read org B's audit rows).
- `npm run build` / `tsc --noEmit` green before any push (type errors, incl.
  tests, fail the Vercel build).

## Migration & ops notes

- New migration under `supabase/migrations/`; apply with
  `supabase db query --linked -f <file>` (not `db push`).
- Backfill: none — audit begins at deploy (documented; historical actions are
  not reconstructable).

## Open questions / future

- Backpressure if `audit_events` write volume spikes (batch/async insert).
- External WORM export for SOC 2 evidence.
- Partitioning once row count crosses ~tens of millions.
