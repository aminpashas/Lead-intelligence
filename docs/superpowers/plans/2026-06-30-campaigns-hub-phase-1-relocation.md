# Campaigns Hub — Phase 1: Route Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate Smart Lists (Audiences) and Mass SMS/Email (Broadcasts) as tabs inside the existing `/campaigns` hub, with back-compat redirects and no change in behavior or access control.

**Architecture:** Pure information-architecture move. The `/campaigns` route already has a `HubNav` layout; we add `Audiences` and `Broadcasts` tabs, relocate the Smart Lists page and the Broadcasts sub-pages under `/campaigns/*`, leave redirect stubs at the old paths, and add explicit `ROUTE_PERMISSION_MAP` entries so the relocated routes keep their original (stricter) permissions. No data model, resolver, or send-logic changes — those are Phases 2–4.

**Tech Stack:** Next.js 16.2.3 App Router (server components, `redirect` from `next/navigation`), TypeScript, Tailwind, vitest (`vitest run`). Reused components: `HubNav`, `SmartListsPage`, `MassSMSComposer`, `MassEmailComposer`, `BroadcastAudit`.

---

## Spec reference

Implements §5 (Information architecture) and the Phase 1 rollout item of
`docs/superpowers/specs/2026-06-30-campaigns-hub-design.md`.

## File structure

**Modify:**
- `src/lib/auth/permissions.ts` — add relocated-route permission entries (Task 1).
- `src/lib/__tests__/auth-permissions.test.ts` — assert relocated routes keep original perms (Task 1).
- `src/app/(dashboard)/campaigns/layout.tsx` — add Audiences + Broadcasts hub tabs (Task 4).
- `src/app/(dashboard)/leads/layout.tsx` — drop the "Smart Lists" tab (Task 3).
- `src/components/dashboard/sidebar.tsx` — remove the standalone Broadcasts nav item (Task 4).
- `src/components/crm/smart-list-detail.tsx` — repoint launch links to `/campaigns/broadcasts/*` (Task 3).
- `src/components/crm/mass-sms-composer.tsx`, `mass-email-composer.tsx` — repoint audit links (Task 2).
- `src/app/(dashboard)/broadcasts/page.tsx`, `sms/page.tsx`, `email/page.tsx`, `audit/page.tsx` — become redirect stubs (Task 2).
- `src/app/(dashboard)/leads/lists/page.tsx` — becomes a redirect stub (Task 3).

**Create:**
- `src/app/(dashboard)/campaigns/broadcasts/layout.tsx` — sub-tab bar (SMS/Email/Audit).
- `src/app/(dashboard)/campaigns/broadcasts/page.tsx` — redirect to `…/sms`.
- `src/app/(dashboard)/campaigns/broadcasts/sms/page.tsx`, `email/page.tsx`, `audit/page.tsx` — render the existing composers.
- `src/app/(dashboard)/campaigns/audiences/page.tsx` — render `SmartListsPage` (moved logic).

---

## Task 1: Preserve access control for the relocated routes

Do this first: it is pure logic, TDD-able, and guards a security-sensitive move (Broadcasts
currently needs the stricter `mass_sms:write` / `mass_email:write`; naive relocation under
`/campaigns` would loosen it to `campaigns:read`).

**Files:**
- Modify: `src/lib/auth/permissions.ts:262-299` (the `ROUTE_PERMISSION_MAP` object)
- Test: `src/lib/__tests__/auth-permissions.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this block inside `src/lib/__tests__/auth-permissions.test.ts` (append a new `describe`
near the existing route-access tests around line 270):

```ts
describe('canAccessRoute — relocated Campaigns hub routes keep original permissions', () => {
  it('Audiences inherits the smart_lists:read gate (same as old /leads/lists)', () => {
    // treatment_coordinator could reach /leads/lists; nurse could not.
    expect(canAccessRoute('treatment_coordinator', '/campaigns/audiences')).toBe(true)
    expect(canAccessRoute('nurse', '/campaigns/audiences')).toBe(false)
  })

  it('Broadcasts SMS/Email/Audit keep their original write/read gates', () => {
    // Matches the existing /broadcasts/* expectations.
    expect(canAccessRoute('treatment_coordinator', '/campaigns/broadcasts/sms')).toBe(true)
    expect(canAccessRoute('treatment_coordinator', '/campaigns/broadcasts/audit')).toBe(true)
    expect(canAccessRoute('nurse', '/campaigns/broadcasts/sms')).toBe(false)
  })

  it('does NOT silently widen Broadcasts to the looser campaigns:read gate', () => {
    // A role with campaigns:read but without mass_sms:write must still be blocked.
    expect(canAccessRoute('nurse', '/campaigns/broadcasts')).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/auth-permissions.test.ts`
Expected: the new cases FAIL — `/campaigns/broadcasts/*` currently resolves via the
`/campaigns` prefix to `campaigns:read`, so `nurse` wrongly returns `true`.

- [ ] **Step 3: Add the relocated-route permission entries**

In `src/lib/auth/permissions.ts`, inside `ROUTE_PERMISSION_MAP`, add these keys right after
the `/campaigns/playbook` line (keep the existing `/leads/lists` and `/broadcasts*` keys —
they still gate the redirect stubs):

```ts
  // Campaigns hub — relocated Audiences (Smart Lists) + Broadcasts (Phase 1 move).
  // Explicit keys keep the original, stricter gates instead of inheriting
  // the looser /campaigns → campaigns:read via prefix match.
  '/campaigns/audiences': 'smart_lists:read',
  '/campaigns/broadcasts': 'mass_sms:write',
  '/campaigns/broadcasts/sms': 'mass_sms:write',
  '/campaigns/broadcasts/email': 'mass_email:write',
  '/campaigns/broadcasts/audit': 'broadcast_audit:read',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/auth-permissions.test.ts`
Expected: PASS (all new cases plus the pre-existing route-access cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/permissions.ts src/lib/__tests__/auth-permissions.test.ts
git commit -m "feat(campaigns): preserve access gates for relocated Audiences + Broadcasts routes"
```

---

## Task 2: Relocate Broadcasts under the Campaigns hub

Move the three Broadcasts pages and their tab bar under `/campaigns/broadcasts`, leaving
redirect stubs at the old `/broadcasts/*` paths.

**Files:**
- Create: `src/app/(dashboard)/campaigns/broadcasts/layout.tsx`
- Create: `src/app/(dashboard)/campaigns/broadcasts/page.tsx`
- Create: `src/app/(dashboard)/campaigns/broadcasts/sms/page.tsx`
- Create: `src/app/(dashboard)/campaigns/broadcasts/email/page.tsx`
- Create: `src/app/(dashboard)/campaigns/broadcasts/audit/page.tsx`
- Modify: `src/app/(dashboard)/broadcasts/page.tsx` (+ `sms`, `email`, `audit` sub-pages) → redirect stubs
- Modify: `src/components/crm/mass-sms-composer.tsx:224`, `src/components/crm/mass-email-composer.tsx:261`

- [ ] **Step 1: Create the Broadcasts sub-layout under the hub**

Create `src/app/(dashboard)/campaigns/broadcasts/layout.tsx`:

```tsx
import { HubNav } from '@/components/dashboard/hub-nav'

/**
 * Broadcasts is now a section of the Campaigns hub. Its own sub-tab bar switches
 * between the one-time Mass SMS / Mass Email composers and the send Audit.
 */
export default function BroadcastsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <HubNav
        items={[
          { name: 'SMS', href: '/campaigns/broadcasts/sms' },
          { name: 'Email', href: '/campaigns/broadcasts/email' },
          { name: 'Audit', href: '/campaigns/broadcasts/audit' },
        ]}
      />
      {children}
    </div>
  )
}
```

- [ ] **Step 2: Create the Broadcasts index redirect**

Create `src/app/(dashboard)/campaigns/broadcasts/page.tsx`:

```tsx
import { redirect } from 'next/navigation'

// The Broadcasts section has no landing view of its own — send visitors to SMS.
export default function BroadcastsIndexPage() {
  redirect('/campaigns/broadcasts/sms')
}
```

- [ ] **Step 3: Create the three Broadcasts pages**

Create `src/app/(dashboard)/campaigns/broadcasts/sms/page.tsx`:

```tsx
import { MassSMSComposer } from '@/components/crm/mass-sms-composer'

export default function MassSMSPage() {
  return <MassSMSComposer />
}
```

Create `src/app/(dashboard)/campaigns/broadcasts/email/page.tsx`:

```tsx
import { MassEmailComposer } from '@/components/crm/mass-email-composer'

export default function MassEmailPage() {
  return <MassEmailComposer />
}
```

Create `src/app/(dashboard)/campaigns/broadcasts/audit/page.tsx`:

```tsx
import { BroadcastAudit } from '@/components/crm/broadcast-audit'

export default function BroadcastAuditPage() {
  return <BroadcastAudit />
}
```

- [ ] **Step 4: Replace the old Broadcasts routes with redirect stubs**

Replace the entire contents of `src/app/(dashboard)/broadcasts/page.tsx`:

```tsx
import { redirect } from 'next/navigation'

// Broadcasts moved under the Campaigns hub. Preserve old links/bookmarks.
export default function LegacyBroadcastsIndex() {
  redirect('/campaigns/broadcasts/sms')
}
```

Replace `src/app/(dashboard)/broadcasts/sms/page.tsx`:

```tsx
import { redirect } from 'next/navigation'

export default function LegacyMassSMS() {
  redirect('/campaigns/broadcasts/sms')
}
```

Replace `src/app/(dashboard)/broadcasts/email/page.tsx`:

```tsx
import { redirect } from 'next/navigation'

export default function LegacyMassEmail() {
  redirect('/campaigns/broadcasts/email')
}
```

Replace `src/app/(dashboard)/broadcasts/audit/page.tsx`:

```tsx
import { redirect } from 'next/navigation'

export default function LegacyBroadcastAudit() {
  redirect('/campaigns/broadcasts/audit')
}
```

Delete the now-unused `src/app/(dashboard)/broadcasts/layout.tsx` (its `HubNav` pointed at
the old paths; the redirect stubs need no tab bar):

```bash
git rm "src/app/(dashboard)/broadcasts/layout.tsx"
```

- [ ] **Step 5: Repoint the "View Audit" links in the composers**

In `src/components/crm/mass-sms-composer.tsx` line 224, change:

```tsx
            <Button variant="outline" onClick={() => window.location.href = '/broadcasts/audit'}>
```
to:
```tsx
            <Button variant="outline" onClick={() => window.location.href = '/campaigns/broadcasts/audit'}>
```

In `src/components/crm/mass-email-composer.tsx` line 261, make the identical change
(`'/broadcasts/audit'` → `'/campaigns/broadcasts/audit'`).

- [ ] **Step 6: Verify the build compiles and the routes resolve**

Run: `npx tsc --noEmit`
Expected: no new type errors.

Run: `npm run dev` and manually confirm:
- `/campaigns/broadcasts` redirects to `/campaigns/broadcasts/sms`
- SMS / Email / Audit sub-tabs render their composers
- Old `/broadcasts`, `/broadcasts/sms`, `/broadcasts/email`, `/broadcasts/audit` all redirect under `/campaigns/broadcasts/*`

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/campaigns/broadcasts" "src/app/(dashboard)/broadcasts" src/components/crm/mass-sms-composer.tsx src/components/crm/mass-email-composer.tsx
git commit -m "feat(campaigns): move Broadcasts (Mass SMS/Email/Audit) under the Campaigns hub with legacy redirects"
```

---

## Task 3: Relocate Audiences (Smart Lists) under the Campaigns hub

Create the Audiences page from the existing `/leads/lists` server logic, redirect the old
path, drop the "Smart Lists" tab from the Leads hub, and repoint the audience launch links.

**Files:**
- Create: `src/app/(dashboard)/campaigns/audiences/page.tsx`
- Modify: `src/app/(dashboard)/leads/lists/page.tsx` → redirect stub
- Modify: `src/app/(dashboard)/leads/layout.tsx`
- Modify: `src/components/crm/smart-list-detail.tsx:125,134`

- [ ] **Step 1: Create the Audiences page**

Create `src/app/(dashboard)/campaigns/audiences/page.tsx` (same query logic that
`leads/lists/page.tsx` uses today):

```tsx
import { createClient } from '@/lib/supabase/server'
import { SmartListsPage } from '@/components/crm/smart-lists-page'
import { resolveActiveOrg } from '@/lib/auth/active-org'

export default async function AudiencesPage() {
  const supabase = await createClient()

  // Effective org honors an agency_admin's entered client account.
  const { orgId } = await resolveActiveOrg(supabase)
  if (!orgId) return null

  const { data: smartLists } = await supabase
    .from('smart_lists')
    .select('*')
    .eq('organization_id', orgId)
    .order('is_pinned', { ascending: false })
    .order('name')

  const { data: stages } = await supabase
    .from('pipeline_stages')
    .select('*')
    .eq('organization_id', orgId)
    .order('position')

  const { data: tags } = await supabase
    .from('tags')
    .select('*')
    .eq('organization_id', orgId)
    .order('name')

  return (
    <SmartListsPage
      smartLists={smartLists || []}
      stages={stages || []}
      tags={tags || []}
    />
  )
}
```

- [ ] **Step 2: Replace the old Smart Lists route with a redirect stub**

Replace the entire contents of `src/app/(dashboard)/leads/lists/page.tsx`:

```tsx
import { redirect } from 'next/navigation'

// Smart Lists became "Audiences" under the Campaigns hub. Preserve old links.
export default function LegacySmartListsRoute() {
  redirect('/campaigns/audiences')
}
```

- [ ] **Step 3: Remove the "Smart Lists" tab from the Leads hub**

The Leads hub now has only "All Leads", so `HubNav` (which hides itself with ≤1 visible tab)
renders nothing. Replace the whole file `src/app/(dashboard)/leads/layout.tsx`:

```tsx
/**
 * Leads section. Smart Lists moved to the Campaigns hub as "Audiences"
 * (/campaigns/audiences), so Leads no longer needs its own tab bar.
 */
export default function LeadsLayout({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>
}
```

- [ ] **Step 4: Repoint the audience → broadcast launch links**

In `src/components/crm/smart-list-detail.tsx`, update the two launch buttons:

Line 125, change:
```tsx
            onClick={() => router.push(`/broadcasts/sms?smart_list_id=${smartList.id}`)}
```
to:
```tsx
            onClick={() => router.push(`/campaigns/broadcasts/sms?smart_list_id=${smartList.id}`)}
```

Line 134, change:
```tsx
            onClick={() => router.push(`/broadcasts/email?smart_list_id=${smartList.id}`)}
```
to:
```tsx
            onClick={() => router.push(`/campaigns/broadcasts/email?smart_list_id=${smartList.id}`)}
```

- [ ] **Step 5: Verify the build compiles and routes resolve**

Run: `npx tsc --noEmit`
Expected: no new type errors.

Run `npm run dev` and manually confirm:
- `/campaigns/audiences` renders the Smart Lists UI
- `/leads/lists` redirects to `/campaigns/audiences`
- `/leads` no longer shows a "Smart Lists" tab
- From an audience detail, the SMS/Email launch buttons open `/campaigns/broadcasts/*`

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/campaigns/audiences" "src/app/(dashboard)/leads/lists/page.tsx" "src/app/(dashboard)/leads/layout.tsx" src/components/crm/smart-list-detail.tsx
git commit -m "feat(campaigns): move Smart Lists to the Campaigns hub as Audiences with legacy redirect"
```

---

## Task 4: Wire the hub tabs and clean up the sidebar

Surface Audiences + Broadcasts as tabs in the Campaigns hub, and remove the now-redundant
standalone Broadcasts item from the sidebar.

**Files:**
- Modify: `src/app/(dashboard)/campaigns/layout.tsx`
- Modify: `src/components/dashboard/sidebar.tsx:58-65` (Engage group) + the `Send` icon import

- [ ] **Step 1: Add Audiences + Broadcasts tabs to the Campaigns hub**

Replace the `HubNav` items in `src/app/(dashboard)/campaigns/layout.tsx` so the file reads:

```tsx
import { HubNav } from '@/components/dashboard/hub-nav'

/**
 * Campaigns hub — the "who" (Audiences / Smart Lists), the automated "nurture"
 * (Campaigns sequences), the one-time "blast" (Broadcasts), and the Funnel Playbook.
 */
export default function CampaignsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <HubNav
        items={[
          { name: 'Campaigns', href: '/campaigns', exact: true },
          { name: 'Audiences', href: '/campaigns/audiences' },
          { name: 'Broadcasts', href: '/campaigns/broadcasts' },
          { name: 'Funnel Playbook', href: '/campaigns/playbook' },
        ]}
      />
      {children}
    </div>
  )
}
```

Note: the `Campaigns` tab uses `exact: true`, so visiting `/campaigns/audiences` or
`/campaigns/broadcasts` does not also highlight it. The Broadcasts sub-tab bar (Task 2)
renders below these hub tabs on `/campaigns/broadcasts/*`.

- [ ] **Step 2: Remove the standalone Broadcasts nav item**

In `src/components/dashboard/sidebar.tsx`, the `Engage` group (around line 58-65) currently
lists Campaigns, Reactivation, Broadcasts. Remove the Broadcasts line so it reads:

```tsx
  {
    label: 'Engage',
    items: [
      { name: 'Campaigns', href: '/campaigns', icon: Megaphone },
      { name: 'Reactivation', href: '/reactivation', icon: RefreshCw },
    ],
  },
```

Then remove the now-unused `Send` icon from the `lucide-react` import block (around line
19) to avoid an unused-import lint error.

- [ ] **Step 3: Verify build + lint**

Run: `npx tsc --noEmit`
Expected: no type errors, and no "Send is declared but never read".

Run: `npm run dev` and confirm the sidebar Engage group shows only Campaigns + Reactivation,
and the Campaigns page shows the four hub tabs.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(dashboard)/campaigns/layout.tsx" src/components/dashboard/sidebar.tsx
git commit -m "feat(campaigns): surface Audiences + Broadcasts hub tabs and drop standalone Broadcasts nav item"
```

---

## Task 5: Full-suite regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS. Pay attention to `auth-permissions.test.ts` — the pre-existing
`/broadcasts/*` and `/leads/lists` cases must still pass (those routes remain, as redirect
stubs, with unchanged permission entries).

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: build succeeds; the route manifest lists `/campaigns/audiences`,
`/campaigns/broadcasts`, `/campaigns/broadcasts/{sms,email,audit}` and the legacy redirect
routes. (A red Lint step on `main` is pre-existing debt and does not indicate this change
broke the build — see the "main CI red" project note.)

- [ ] **Step 3: Manual redirect matrix**

With `npm run dev`, confirm each old URL lands on its new home:

| Old URL | Expected destination |
|---|---|
| `/broadcasts` | `/campaigns/broadcasts/sms` |
| `/broadcasts/sms` | `/campaigns/broadcasts/sms` |
| `/broadcasts/email` | `/campaigns/broadcasts/email` |
| `/broadcasts/audit` | `/campaigns/broadcasts/audit` |
| `/leads/lists` | `/campaigns/audiences` |

- [ ] **Step 4: No stray references remain**

Run: `grep -rn "/broadcasts" src --include='*.tsx' --include='*.ts' | grep -v "app/(dashboard)/broadcasts/" | grep -v "permissions.ts" | grep -v ".test."`
Expected: no results (all in-app links now point at `/campaigns/broadcasts/*`). The
`permissions.ts` legacy keys and the `.test.ts` legacy assertions are intentionally kept.

---

## Out of scope (subsequent phases, separate plans)

- **Phase 2** — the `keywords` criteria clause + resolver + `pg_trgm`/`tsvector` indexes +
  builder UI (spec §6).
- **Phase 3** — the audience → "Start a Campaign" launch flow with `smart_list_id` prefill
  (spec §7). The broadcast half is partially pre-wired here (Task 3, Step 4).
- **Phase 4** — the eligibility/consent gate + A2P US-SMS hard-block banner (spec §8).
