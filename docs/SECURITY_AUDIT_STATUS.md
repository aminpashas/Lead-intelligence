# Security Audit — Production Readiness Status

**Date:** 2026-06-27
**Branch:** `feat/dgs-li-agent-platform`
**Scope:** Adversarial end-to-end audit across three personas — PATIENT, TEAM MEMBER, COMPANY ADMIN.
**Supabase project (prod):** Lead Intelligence — `bnmnirzfwopqklsitjgq` (org `mxecrbpuoxuhxhinlyrg`)

> **How to resume in a new chat:** point at this file. Everything below — what's
> fixed, what's deployed vs uncommitted, what's still open — is current as of the
> date above. Start from the **"Pick up here"** section at the bottom.

---

## 1. Findings & status

| # | Sev | Finding | Fix | Deployed? |
|---|-----|---------|-----|-----------|
| **C1** | 🔴 Critical | **Self-escalation to `agency_admin` via PostgREST.** `user_profiles` UPDATE policy (`user_profiles_update`) is `USING (id = auth.uid())` with **no `WITH CHECK`** → Postgres reuses USING as the row check, which constrains only `id`, not `role`/`organization_id`. Any authenticated staff user could `PATCH /rest/v1/user_profiles?id=eq.<self> {"role":"agency_admin"}` with their own JWT → `is_agency_admin()` true → SELECT on all orgs → insert `agency_active_org` row → `get_user_org_id()` resolves into any tenant → full cross-practice PHI access. Bypasses every app-layer `isAdminRole()` check. | BEFORE UPDATE trigger `guard_user_profile_privileged_columns` (pins `id`, blocks self role/org change, blocks cross-org re-home, restricts `agency_admin`/`owner` grants to agency_admin) + name-agnostic `WITH CHECK (id = auth.uid())` on the self-update policy. | ✅ **Applied + verified on prod** (migration `20260627213747`). Branch-validated both directions. |
| **A1** | 🟠 Med | `autopilot/settings` PATCH gated on bare `role !== 'admin'` — locked out every real admin role (`doctor_admin`/`office_manager`/`owner`/`agency_admin`) and relied on RLS without explicit user resolution. | Use `isAdminRole(profile.role)` + explicit `auth.getUser()` / `eq('id', user.id)`. | ⏳ Code only (uncommitted) |
| **T1** | 🟠 Med | Any admin-group role could deactivate a **higher**-privileged user (e.g. `doctor_admin` deactivating the `owner` or overseeing `agency_admin`); no last-admin protection. | Added `roleRank` / `canActOnRole` helpers; PATCH + DELETE now require the caller to outrank the target, and DELETE protects the last active admin. | ⏳ Code only (uncommitted) |
| **P1** | 🟠 Med | `cases/patient/[shareToken]/accept` skipped the expiry + status guards its sibling GET enforces → expired/leaked link could flip case→completed and trigger AI contract generation. | Added `share_token_expires_at` check + `status in ('patient_review','completed')` filter, mirroring the GET. | ⏳ Code only (uncommitted) |
| **P2** | 🟠 Med | `booking/[orgId]/book` overwrote an existing lead's `first_name`/`last_name`/`phone` from the unauthenticated path (phone = SMS destination) — anyone knowing a victim's email + public `orgId` could rewrite it. | Existing-lead path now only attaches the appointment (`status` + `consultation_date`); identity/phone untouched. | ⏳ Code only (uncommitted) |
| **P3** | 🟡 Low | E-signature `signer_ip` trusted `x-forwarded-for` first hop (client-spoofable) — weak signature audit evidence. | Prefer platform-injected `x-vercel-forwarded-for` / `x-real-ip`, fall back to `x-forwarded-for`. | ⏳ Code only (uncommitted) |

**Verdict:** the C1 database hole (the one that made app-layer RBAC moot) is closed on prod. The five app-layer fixes are written and typecheck-clean but **not deployed until the code ships.**

---

## 2. Files changed (working tree, uncommitted)

- `supabase/migrations/20260627_user_profiles_privilege_guard.sql` — **new** (C1). Already applied to prod via MCP `apply_migration`; the in-repo file is name-agnostic so it's also correct for any rebuilt env.
- `src/lib/auth/permissions.ts` — added `ROLE_RANK`, `roleRank()`, `canActOnRole()` (T1).
- `src/app/api/team/[id]/route.ts` — rank guard on PATCH/DELETE + last-admin protection (T1).
- `src/app/api/autopilot/settings/route.ts` — `isAdminRole()` gate + explicit user resolution (A1).
- `src/app/api/cases/patient/[shareToken]/accept/route.ts` — expiry/status guard (P1).
- `src/app/api/booking/[orgId]/book/route.ts` — no identity/phone overwrite for existing leads (P2).
- `src/app/api/contracts/patient/[shareToken]/sign/route.ts` — trusted IP header (P3).

`npx tsc --noEmit` → exit 0.

---

## 3. C1 validation evidence

Validated on a throwaway Supabase branch (Postgres 17), then torn down:
- **Without the trigger:** a `member` self-updated its own role to `admin` using only its emulated JWT context → `escalated_without_fix = true`. Vulnerability confirmed real.
- **With the trigger:** identical attack raised `You cannot change your own role`; role stayed `member`; a benign self-edit (`full_name`) still succeeded.
- **Prod post-apply verify:** `trigger_installed = true`, `user_profiles_update.with_check = (id = auth.uid())`, migration registered. (No destructive test run against real prod rows — behavior already proven on the branch with identical objects.)

---

## 4. NEW issues surfaced during prod pre-flight (NOT yet fixed)

- **R1 🟠 — `user_profiles_delete` is org-wide, not admin-gated.** Policy is `USING (organization_id = get_user_org_id())`, so any authenticated org member can hard-DELETE any colleague's profile in their org via PostgREST. App soft-deletes; RLS doesn't enforce that. Fix: restrict delete to admins (or rank), or remove direct delete and force soft-delete.
- **R2 🟠 (functional) — team management may be non-functional under prod RLS.** Prod has **no admin-manage policy** on `user_profiles` — only `user_profiles_update USING (id = auth.uid())`. The `team/[id]` routes use the auth'd client, so an admin updating/deactivating *another* user likely affects 0 rows. Confirm whether there's a service-role path; if not, team management is silently broken (fails closed). Note: the in-repo migration files reference `"Admins can manage user profiles"` which does **not** exist on prod under that name.

---

## 5. Migration drift (DR/staging risk — recorded, not fixed)

Branch replay reached `MIGRATIONS_FAILED` after only **17 migrations** and was missing objects prod has (e.g. `agency_admin` from migration 018; `user_profiles` policies named differently than the source files). **The tracked migration history cannot rebuild the prod schema** — prod was partly built via ad-hoc SQL. Reconcile before relying on branches/staging/DR. Likely compounded by unmerged migrations on `feat/dgs-li-agent-platform`.

---

## 6. Healthy / verified-sound (no action)

- Patient share tokens: `gen_random_uuid()` / `randomBytes(24)` — not guessable.
- `consent/confirm`: atomic single-use token claim.
- `get_user_org_id()` (038): role-guarded agency override, `search_path` pinned.
- Service bridge (`/api/v1/*`, `lib/auth/service-key.ts`): timing-safe key compare, per-caller keys, **fail-closed** org allowlist in prod.
- Cron auth: fails closed when `CRON_SECRET` unset (`lib/cron/with-cron.ts`).
- Twilio webhook signature validated with `timingSafeEqual`.
- US SMS hard-gated on `us_sms_enabled` at send path (A2P 10DLC).

---

## 7. Pick up here (next actions, recommended order)

1. **Commit + PR the 6 fixes** (A1/T1/P1/P2/P3 + the C1 migration file) — the app-layer fixes are NOT live until shipped. *(asked; awaiting go-ahead)*
2. **Fix R1 + R2** the same way (admin-gate `user_profiles_delete`; add/repair the admin-manage UPDATE policy so team management works and is org+rank scoped).
3. **Reconcile migration drift** (§5) so environments are reproducible.
4. **External blocker:** A2P 10DLC — US SMS stays gated until the campaign is VERIFIED and `us_sms_enabled` is flipped (pending Twilio, not code).
5. **Cleanup (non-blocking):** consolidate the ~4 auth patterns into one `requireAdmin()` helper (A1 was drift from that); tighten middleware `pathname.includes('.')` bypass.

**Related memory:** `user-profiles-privesc`, `migration-replay-drift`, `series-a-audit`.
