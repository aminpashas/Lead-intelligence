# Campaigns Hub — Unified Audiences, Sequences & Broadcasts

**Date:** 2026-06-30
**Branch:** `feat/full-arch-cold-reactivation`
**Status:** Design approved — ready for implementation plan

---

## 1. Problem

Messaging capability is spread across three disconnected places, and the segmentation
engine that should tie them together is buried:

- **Campaigns** (`/campaigns`) — multi-step drip/trigger SMS+email sequences that already
  target a Smart List.
- **Broadcasts** (`/broadcasts/{sms,email,audit}`) — one-time Mass SMS / Mass Email blasts,
  a sibling of Campaigns rather than part of it.
- **Smart Lists** (`/leads/lists`) — the audience/segmentation engine, hidden under Leads.

A user who wants to "organize a list by CRM stage / activity / tags / keywords and run a
campaign against it" has to visit three separate areas and mentally connect them. The
deployed app still shows the older flat nav where Mass SMS and Mass Email are top-level
peers, which is the surface the request came from.

The segmentation itself mostly **already exists**: `SmartListCriteria`
(`src/types/database.ts:808`) supports CRM stage (`stages`), patient activity
(`engagement_min/max`, `statuses`, `ai_qualifications`, score), `tags` (AND/OR), source,
location, dates, and consent. The one genuine capability gap is **keyword/text filtering**.

## 2. Goals

1. Consolidate Audiences (Smart Lists), Campaigns (sequences), and Broadcasts (Mass
   SMS/Email) under a single **Campaigns hub** with three tabs.
2. Add a **unified keyword filter** to the audience builder spanning conversation content,
   lead text fields, inbound SMS trigger words, and tag names.
3. Make **"build an audience → launch a campaign or broadcast against it"** a first-class,
   one-click flow.
4. Enforce a **consent + A2P eligibility gate** on every send path.

## 3. Non-goals

- No redesign of the underlying campaign/enrollment engine, Smart List data model
  (beyond the additive `keywords` clause), or the scoring engine.
- No change to Reactivation's specialized cold-lead flow — it stays its own destination
  and simply reuses Audiences.
- No denormalized search materialization in v1 (see §6.3, deferred).
- Voice-call transcript search is out of scope for v1 (noted as future in §6.2).

## 4. Approved decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Scope | Reorg **+** fill gaps (keyword filter + guided launch flow) |
| D2 | Structure | **Approach A** — `Campaigns` hub with `Campaigns \| Audiences \| Broadcasts` tabs |
| D3 | Keyword scopes | All four: conversation content, lead fields, inbound SMS, tags |
| D4 | SMS/A2P guard | **Hard-block US SMS** with an "A2P registration pending" banner until 10DLC passes; email + non-US unaffected |
| D5 | Membership | **Broadcasts static** (snapshot at send), **campaigns dynamic** (continuous enrollment) |

## 5. Information architecture

`/campaigns` becomes a hub rendered by a shared layout + tab bar:

```
Campaigns (hub)
├─ Campaigns    /campaigns              ← existing sequences list (default tab)
├─ Audiences    /campaigns/audiences    ← Smart Lists (moved from /leads/lists)
└─ Broadcasts   /campaigns/broadcasts   ← Mass SMS / Mass Email / Audit (moved from /broadcasts)
                /campaigns/broadcasts/{sms,email,audit}
```

- **Sidebar** (`src/components/dashboard/sidebar.tsx`): the "Engage" group becomes
  `Campaigns`, `Reactivation`. `Broadcasts` and any Smart Lists entry are removed as
  standalone items — they are now tabs inside the hub.
- **Back-compat redirects** (keep bookmarks and in-app links alive):
  - `/broadcasts` and `/broadcasts/*` → `/campaigns/broadcasts/*`
  - `/leads/lists` → `/campaigns/audiences`
- **Component reuse:** the existing `broadcasts` route UIs, `smart-lists-page`,
  `smart-list-builder`, `smart-list-detail`, `campaigns-list`, and `campaign-builder`
  move/mount under the new routes with minimal changes — this is primarily a relocation,
  not a rewrite.

## 6. Audiences + keyword filter

### 6.1 Criteria extension

Add a `keywords` clause to `SmartListCriteria` (`src/types/database.ts`). It is additive
JSONB — existing Smart Lists are unaffected and deserialize with `keywords` undefined.

```ts
keywords?: {
  terms: string[]                                  // one or more search terms
  match: 'any' | 'all'                             // OR / AND across terms
  scopes: ('conversation' | 'lead_fields' | 'inbound_sms' | 'tags')[]
}
```

### 6.2 Resolver behavior

Extend `resolveSmartListLeads` / `applySmartListCriteria`
(`src/lib/campaigns/smart-list-resolver.ts`). For each selected scope, resolve the set of
matching `lead_id`s, combine per `match` mode, then **intersect** with the lead-ID set
produced by the rest of the criteria (stage, activity, consent, tags-clause, …). Keyword
resolution runs as a pre-filter (same pattern already used for the `tags` clause), then the
main `leads` query applies the structured filters over that ID set.

- **`lead_fields`** — case-insensitive match across `name`, `email`, `notes`, `source`,
  `campaign` on the `leads` row. `pg_trgm` `ILIKE '%term%'`.
- **`conversation`** — full-text search over `messages.body` (all directions/channels) →
  `DISTINCT lead_id`. Table confirmed: `messages(lead_id, organization_id, direction,
  channel, body)`.
- **`inbound_sms`** — `messages` where `direction = 'inbound' AND channel = 'sms'` and
  `body` matches the term → `lead_id`. Serves "leads who replied YES/INFO/…".
- **`tags`** — resolve term against tag **names**, then reuse the existing tag → `lead_tags`
  → `lead_id` path. (Distinct from the structured `tags` clause, which selects tags by ID.)

`match: 'all'` intersects the per-term ID sets; `match: 'any'` unions them. Scope results
for a single term are unioned across scopes (a term matches if it hits *any* selected scope).

*Future:* extend `conversation` scope to include `voice_calls` transcript entries
(`VoiceCallTranscriptEntry.content`). Out of scope for v1.

### 6.3 Performance

Target scale is ~34k+ leads with large message history.

- **Chosen (v1):** query-time resolution with supporting indexes — always fresh, no
  denormalization:
  - `pg_trgm` GIN index on the searched `leads` text columns.
  - `tsvector` GIN index on `messages.body` (partial index for the inbound-SMS path:
    `WHERE direction = 'inbound' AND channel = 'sms'`).
  - All keyword queries are `organization_id`-scoped first (RLS + index) to bound the scan.
- **Deferred alternative:** a maintained `leads.search_document tsvector` (lead fields +
  concatenated recent messages) via trigger. Faster reads, but adds trigger complexity and
  staleness on new inbound messages. Revisit only if v1 latency is unacceptable.

### 6.4 Builder UI

The audience builder (`smart-list-builder`) gains a Keywords section: a term input (chips),
an any/all toggle, and scope checkboxes (Conversations, Lead details, Inbound replies,
Tags). Live match-count preview reuses the existing `countOnly` resolver path.

## 7. Audience → Launch flow

Each audience (list row + detail view) gets a **Launch** action:

- **Start a Campaign** → opens `campaign-builder` pre-filled with that `smart_list_id`
  (the builder already accepts `smart_list_id`; §`campaign-builder.tsx:196`).
- **Send a Broadcast** → opens the Mass SMS / Mass Email composer pre-filled with that
  audience.

This closes the "pieces don't connect" gap: build a list → one click → act on it.

## 8. Eligibility & consent gate (hard requirement)

Context: US SMS is currently blocked on a FAILED A2P 10DLC campaign, and ~33k leads are of
unknown consent (imported third-party lead-gen). Every send path must therefore:

1. **Show a live eligibility breakdown before sending** — total in audience, SMS-eligible
   (`sms_consent = true AND sms_opt_out = false AND has phone`), email-eligible
   (`email_consent = true AND email_opt_out = false AND has email`), and
   excluded-with-reasons. Reuses consent fields already in `SmartListCriteria`.
2. **Default SMS to consent-required** and refuse to send to non-consented leads.
3. **Hard-block US-number SMS** while A2P 10DLC is unregistered/failed (D4), with an "A2P
   registration pending" banner. Email and non-US SMS are unaffected. The block reads a
   single source-of-truth flag so it can be lifted when 10DLC passes.

## 9. Membership semantics (D5)

- **Broadcasts** — resolve the audience once at send time, snapshot recipients, record the
  send. New matching leads afterward are *not* included.
- **Drip / Trigger campaigns** — the existing enrollment engine continues to auto-enroll
  new leads that match the audience criteria.

## 10. Migration & back-compat

- Route redirects (§5). Sidebar update (§5).
- One additive migration: the `keywords` JSONB shape needs no column change (already inside
  `smart_lists.criteria`); the migration only adds the **indexes** in §6.3.
- No data backfill. Existing Smart Lists, campaigns, and broadcasts are untouched.

## 11. Testing

Following existing patterns in `src/lib/__tests__/`:

- **Unit — keyword resolver:** each scope in isolation; `any` vs `all`; multi-scope union;
  intersection with structured criteria; empty/whitespace terms; org scoping.
- **Unit — eligibility counts:** SMS/email eligible and excluded-reason tallies; US-SMS
  hard-block flag on/off.
- **Integration:** launch-from-audience prefills `smart_list_id` / audience; the old
  `/broadcasts/*` and `/leads/lists` routes redirect correctly.

## 12. Rollout

1. Route relocation + redirects + sidebar (no behavior change) — shippable on its own.
2. Keyword criteria + resolver + indexes + builder UI.
3. Launch flow wiring.
4. Eligibility/consent gate + A2P hard-block banner.

Each step is independently deployable behind the existing branch.

## 13. Open questions

None blocking. Revisit if v1 keyword latency forces the deferred `search_document`
materialization (§6.3), or if voice-transcript search becomes a requirement (§6.2).
