# Audit Trail — SQL Smoke Verification

Copy-paste checks for `audit_events` and its trigger, run against the linked
Supabase project (`supabase db query --linked -f <file>`). Results recorded from
the 2026-07-04 prod apply of `supabase/migrations/20260704160000_audit_events.sql`.

## 1. Append-only (WORM) enforcement — ✅ verified

```sql
insert into public.audit_events (organization_id, actor_type, action, source)
select id, 'system', 'audit.selftest', 'api_route' from public.organizations limit 1;
update public.audit_events set action = 'x' where action = 'audit.selftest';
```
Expected: the `UPDATE` raises
`ERROR: Table public.audit_events is append-only — UPDATE is not permitted`
(from `prevent_row_mutation()`), which aborts the transaction (self-test insert
rolls back). A `DELETE` raises the same way. **Result: confirmed** — UPDATE
raised the append-only error; nothing persisted.

## 2. Trigger coverage + actor attribution + redaction — ✅ verified

```sql
select public.set_audit_config('app.actor_type','user');
select public.set_audit_config('app.actor_id','00000000-0000-0000-0000-000000000001');
select public.set_audit_config('app.actor_label','Smoke Test');
update public.leads set first_name = first_name where id = (select id from public.leads limit 1);
select action, actor_type, actor_label, source,
       (before ? 'email') as has_email_key,
       (before ->> 'email') as email_value,
       (before ->> 'first_name') as first_name_value
from public.audit_events where resource_type = 'leads'
order by occurred_at desc limit 1;
```
Expected: a `leads.update` row, `source='db_trigger'`, `actor_type='user'`,
`actor_label='Smoke Test'`, `email_value='[redacted]'`, `first_name_value` shown
in plaintext. **Result: confirmed** — the trigger fired on a direct SQL update
(coverage is app-independent), attributed the actor from the GUCs, and redacted
the `email` column while keeping `first_name`. (This left one benign
`leads.update`/"Smoke Test" row in the append-only log — expected, cannot be
deleted by design.)

## 3. RLS cross-org isolation — run authenticated

Run in the Supabase SQL editor **authenticated as an org-A user** (or via an
org-scoped client), NOT the service role (service role bypasses RLS):

```sql
-- Must return 0: an org user can never see another org's audit rows.
select count(*) from public.audit_events
where organization_id <> public.get_user_org_id();
```
Expected: `0`. (Policy `audit_events_org_select` mirrors the proven
`hipaa_audit_log` SELECT policy: `organization_id = public.get_user_org_id()`.)

**Result (2026-07-04): confirmed** — simulated an authenticated user (set
`request.jwt.claims.sub` + `set local role authenticated`, which is subject to
RLS, unlike the superuser service connection): `cross_org_leak = 0`, `visible_rows`
scoped to the user's own org only.

## 5. Coverage note

As of migration `20260704170000`, the row-change trigger is attached to **53
org-scoped tables** (all except logs/recursion, event-queue plumbing,
sync/telemetry rollups, comms-volume tables whose sends are already audited via
`recordAudit`, and bulk-membership tables). Redaction is by column-NAME pattern
(`audit_is_sensitive_col`) so newly-audited tables are protected automatically —
verified on `patients`: sensitive columns present, zero leaked unredacted.

## 4. Trigger attachment inventory

```sql
select event_object_table as table_name, trigger_name
from information_schema.triggers
where trigger_name like 'trg_audit_%'
order by 1;
```
Expected: `trg_audit_leads`, `trg_audit_appointments`, `trg_audit_clinical_cases`,
`trg_audit_user_profiles`, `trg_audit_connector_configs` (each present only if the
base table exists), plus `trg_audit_events_append_only` on `audit_events`.
