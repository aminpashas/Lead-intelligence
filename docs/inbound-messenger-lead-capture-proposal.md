# Inbound Facebook/Instagram Messenger → Lead Capture

**Status:** ⚠️ **Superseded in practice — read §0 first.** The direct-Meta plan below
is still the correct long-term shape, but is NOT what shipped.
**Raised by:** Lead Intelligence (LI)
**Owner (proposed):** Growth Studio (demand-gen) — with Patient Engagement / Dion Desk for the conversation surface
**LI's role:** downstream consumer — **LI does not own a Messenger inbox**

---

## 0. What actually shipped (2026-07-19): capture via GHL, not direct Meta

The plan below routes FB/IG through a **direct Meta `messages` subscription** owned
by Growth Studio. That is blocked on Meta **App Review** for `pages_messaging`
(weeks of lead time) and on a repo that isn't checked out.

**GHL already holds the Meta page connection** (the `ghl-capture-only → LI
operations` architecture), so it is *already receiving* these DMs. LI was simply
throwing them away. The shipped fix removes that discard:

| Blocker | Fix |
|---|---|
| `mapGhlChannel('TYPE_FACEBOOK')` → `null`, dropped before persist | maps to `messenger` / `instagram` (`src/lib/ghl/conversations.ts`) |
| `isConversational()` allowed only sms/email/web_chat/whatsapp | social channels included (`src/lib/ghl/ingest-message.ts`) |
| `conversations.channel` / `messages.channel` CHECK rejected the insert | `supabase/migrations/20260719120000_social_dm_channels.sql` |
| unknown contact → `no_lead` → dropped (**the actual missing alert**) | inbound social DM from an unknown contact creates the lead + fires `notifyNewLead` (`src/app/api/webhooks/ghl/message/route.ts`) |

This keeps LI within its lane: it does **not** connect to Meta and does **not**
build a Messenger inbox — it mirrors what GHL already captured, exactly as it
already does for SMS/email. The reply surface stays with GHL/PE/Desk.

**Preconditions this depends on (verify before trusting it):**
1. the FB/IG page is connected inside GHL;
2. GHL is configured to POST each message to
   `/api/webhooks/ghl/message?org=<uuid>` with the `x-ghl-webhook-secret` header;
3. `GHL_WEBHOOK_SECRET` is set in Vercel (it is absent from `.env.local.example`);
4. the migration is applied to prod.

The `lead.captured` bus consumer (§4) remains built and inert — it is the
migration path for when a direct-Meta producer does exist.

---

## 1. The gap

Prospective patients are DMing the practice's Facebook/Instagram Page. Those
messages land only in the raw Meta Page inbox — **no Dion app ingests them.** So:

- no lead row is created,
- no new-lead notification fires,
- the DM never joins the funnel (Growth Studio → LI → Patient Engagement).

This was mis-reported as an LI notification bug. It is not. LI's new-lead alert
(`notifyNewLead`) only fires when a lead is *ingested*, and nothing ingests
Messenger. Confirmed across every LI intake path:

| Path | Behaviour | Evidence |
|---|---|---|
| Meta webhook | Only `change.field === 'leadgen'` (Lead Ad instant forms). All other fields `continue`-skipped. Messenger arrives under the **`messages`** field → dropped. | `src/app/api/webhooks/meta/route.ts:84` |
| Meta connector | Only `capi.ts` / `lead-ads.ts` / `pull-insights.ts`. No `messages` subscription, no PSID handling. | `src/lib/connectors/meta/` |
| GHL conversation import | `mapGhlChannel` returns `null` for FB/IG/GMB → skipped. Pinned by test `TYPE_FACEBOOK → null`. | `src/lib/ghl/conversations.ts:163` |

## 2. Why this is not an LI build

Per the suite workflow-ownership matrix (`ECOSYSTEM.md`), Messenger splits three ways:

| Piece | System of record | Matrix line |
|---|---|---|
| Two-way Messenger **inbox / reply thread** | **Patient Engagement** ("patient comms — SMS/email/**chat**") — *"feed it; don't add a parallel inbox"* | ECOSYSTEM.md:133 |
| Omnichannel unification into tickets | **Dion Desk** (contact center) | ECOSYSTEM.md:135 |
| Inbound social **DM as a demand-gen lead** | **Growth Studio** ("inbound leads, brand mentions, attribution") | ECOSYSTEM.md:145 |
| **Lead record + qualification/scoring** once the lead exists | **Lead Intelligence** (sales/lead CRM) | ECOSYSTEM.md:136 |

> The one rule (ECOSYSTEM.md:149): building something in the right-hand column?
> Stop — integrate via the bus + master-records instead.

**Conclusion:** the channel owner subscribes to Meta and emits a `lead.*` event.
LI consumes it through the existing bus path and does the qualification. LI adds
**nothing** to the Messenger channel itself.

## 3. Proposed flow

```
FB/IG Page  ──(Meta `messages` webhook)──▶  Growth Studio (or PE/Desk)
                                                │  create/resolve person via @dion/master-records
                                                │  emit lead.captured on the bus
                                                ▼
                                    hub /api/bus/ingest  ──▶  Lead Intelligence
                                                │  ingestLead(...) → dedup → score → notifyNewLead
                                                ▼
                                         new-lead alert fires ✅
```

## 4. The `lead.captured` event LI needs

> **Renamed from `lead.created` during implementation.** LI *emits* `lead.created`
> itself (ECOSYSTEM.md:72). If LI also consumed that type, the hub fan-out would
> deliver LI's own emissions back to LI and mint duplicate leads — an echo loop.
> The inbound type is therefore **`lead.captured`**, and LI's receiver additionally
> rejects any event with `source: "lead-intelligence"`. Producers: use
> `lead.captured`.

LI already vendors the spine envelope (`src/lib/bridges/dion/envelope.ts`). An
inbound event must validate against it. Minimum shape:

```jsonc
{
  "id": "<uuid>",
  "envelopeVersion": 1,
  "source": "dion-growth-studio",        // the emitting product (envelope enum)
  "occurredAt": "2026-07-17T21:37:00Z",
  "dionPracticeId": "<practice id | null>",
  "idempotencyKey": "meta-msg-<PSID>-<first_message_id>",  // dedup on retries
  "type": "lead.captured",
  "data": {
    "channel": "messenger",              // messenger | instagram
    "psid": "<page-scoped sender id>",   // the ONLY stable identifier Meta gives
    "pageId": "<meta page id>",
    "displayName": "Barbara J. Haffner", // name is usually all Meta provides
    "firstName": "Barbara",
    "lastName": "Haffner",
    "email": null,                       // NOT available until the person shares it
    "phone": null,                       // NOT available until the person shares it
    "firstMessageText": "...",           // optional context for scoring
    "firstMessageAt": "2026-07-17T21:37:00Z",
    "consent": {                         // see §6 — do NOT fabricate true
      "channel": "messenger",
      "basis": "inbound_initiated"       // they messaged us first
    }
  }
}
```

### How LI maps it to `ingestLead` (`src/lib/leads/ingest.ts`)

| Event field | `IngestInput` field | Note |
|---|---|---|
| `firstName` (fallback `displayName`) | `firstName` | required; write `'Unknown'` if truly absent |
| `lastName` | `lastName` | |
| `email` / `phone` | `email` / `phoneRaw` | usually **null** — that's expected |
| `"Messenger"` / `"Instagram DM"` | `source` | new `lead_sources` rows |
| `"messenger"` | `sourceType` | **new** source_type value |
| `psid` | `externalRef` | stable dedup key on the LI side |
| `["messenger"]` | `tags` | |
| — | `utm_source: "facebook"`, `utm_medium: "social"` | organic social, not paid |
| `consent` | `consent` | leave email/sms/call **UNKNOWN**, not false |

LI then runs its normal dedup → score → `notifyNewLead` pipeline for free.

## 5. What Meta actually gives you (design constraint)

A Messenger `messages` webhook event carries a **PSID** (page-scoped user id) and,
via the Graph API, usually just the person's **name and profile pic** — **no email
or phone** until the user volunteers it in conversation or a form. So:

- `externalRef = PSID` is the dedup key, not email/phone.
- Deduping against existing LI leads by email/phone will mostly miss → expect a
  net-new lead per new conversation. Re-linking to an existing patient is
  `@dion/master-records`' job, not LI's.
- **24-hour messaging window:** Meta only allows free-form replies within 24h of
  the user's last message (message tags / paid required after). This is a
  reply-side constraint for whoever owns the inbox (PE/Desk), not for LI.

## 6. Consent (must be decided before any auto-outreach)

LI's consent model assumes **uploaded/imported leads already consented** and gates
only on explicit opt-out. A cold Messenger DM does **not** fit that:

- The person **messaged the Page first** → implied consent to reply **on Messenger,
  within the 24h window**.
- That is **not** consent to SMS, email, or phone. LI must ingest with those
  channels' consent **UNKNOWN** (the ingest path already does this — never
  fabricates `false`), so nothing auto-dials/texts a Messenger lead until the
  re-permission flow earns it.

**Decision needed:** does a Messenger lead enter LI's normal speed-to-lead /
autopilot, or a Messenger-only reply path owned by PE/Desk? Recommend the latter
until cross-channel consent is captured.

## 7. Open questions for the owning team

1. **Who owns the Meta `messages` subscription** — Growth Studio, Patient
   Engagement, or Dion Desk? (Recommend Growth Studio for capture + `lead.*`;
   PE/Desk for the reply inbox.)
2. Instagram DMs and FB comments/GMB messages — same pipe or separate?
3. Identity resolution: is PSID → person handled in `@dion/master-records` before
   the event, or does LI dedup on PSID alone?
4. Should LI emit a `conversation.*` back so the DM thread shows in LI's read-only
   conversation view, or does that stay entirely in PE/Desk?

## 8. What LI will do (and won't)

- ✅ Add a bus consumer for `lead.captured` where `data.channel ∈ {messenger,
  instagram}` → `ingestLead(... sourceType:'messenger', externalRef: psid ...)` →
  score + `notifyNewLead`.
- ✅ Add `"messenger"` as a `sourceType` and the source labels.
- ❌ Not subscribe to Meta's `messages` webhook.
- ❌ Not build a Messenger inbox or reply UI (violates ECOSYSTEM.md:133/135).
- ❌ Not auto-contact Messenger leads on SMS/email/voice without earned consent.
