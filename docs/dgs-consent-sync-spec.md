# DGS → LI Consent-Sync Caller Spec

**Audience:** whoever owns **Dion Growth Studio (DGS)** / the GoHighLevel integration.
**Purpose:** close the consent loop. LI now exposes a receiver that records consent
**changes** (opt-in / opt-out) onto **existing** leads. DGS must call it whenever a
GHL contact's consent state changes, so LI's send-gate stays in sync with GHL's DND.

> **Why this matters:** the existing `POST /api/v1/leads` bridge only sets consent on
> lead *creation* and wrote opt-outs as status `declined` **without** the hard
> `sms_opt_out` flag. Result today: LI shows `sms_opt_out = 0` while 1,000+ leads are
> really opted out in GHL. Until DGS calls this endpoint, an opt-out in GHL never
> becomes an enforceable opt-out in LI — and any second channel (LI SMS post-10DLC,
> email) can re-contact someone who said STOP.

---

## Endpoint

```
POST  {LI_BASE_URL}/api/v1/consent
Authorization: Bearer {GROWTH_STUDIO_SERVICE_KEY}     # same key as /api/v1/leads
Content-Type: application/json
```

`LI_BASE_URL` = the Lead Intelligence deployment (prod). The key and the org
allowlist (`GROWTH_STUDIO_ALLOWED_ORG_IDS`) are already configured for the lead bridge.

## Request body

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `customer_id` | uuid | ✅ | The LI org id (= DGS customer id). Dion Health SF = `fa64e53c-3d9b-493e-b904-59580cb3f29c`. |
| `action` | `"opt_in"` \| `"opt_out"` | ✅ | The consent change. |
| `channels` | array of `"sms"` \| `"email"` \| `"voice"` | ✅ (≥1) | Which channel(s) the change applies to. |
| `external_ref` | string | ⬦ one of these three | **Preferred.** DGS `inbound_leads.id` — exact, indexed match. |
| `email` | string (email) | ⬦ | Fallback resolution (hashed match within org). |
| `phone` | string | ⬦ | Fallback resolution (normalized to E.164 then hashed). |
| `source` | string (≤120) | optional | Provenance, e.g. `ghl_reply_yes`, `ghl_stop`, `ghl_dnd`. Recorded on opt-in. |
| `occurred_at` | ISO 8601 | optional | When it happened in GHL. Defaults to now. |

At least one of `external_ref` / `email` / `phone` is required. **Always send
`external_ref` when you have it** — it's the only exact identifier.

## Response

```json
{ "ok": true, "lead_id": "<uuid>", "action": "opt_out", "channels": ["sms"] }
```

| Status | Meaning | DGS action |
|--------|---------|-----------|
| `200` | Applied (or idempotent no-op) | done |
| `400` | `invalid_body` | fix payload; do not retry as-is |
| `401` | bad/missing service key | check secret |
| `403` | `forbidden_org` | `customer_id` not in this caller's allowlist |
| `404` | `lead_not_found` | lead isn't in LI yet — see "ordering" below |
| `500` | `consent_write_failed` | transient; safe to retry |

The endpoint is **idempotent**: re-sending the same opt-out/opt-in is a no-op (the DB
triggers de-dupe the `consent_log` audit row), so **retry freely** on 5xx/network errors.

---

## GHL event → payload mapping

Wire these to GHL workflow triggers (or DGS's webhook handler for GHL events):

### 1. Contact replies STOP / UNSUBSCRIBE / QUIT (SMS opt-out)
```json
{ "customer_id": "<org>", "external_ref": "<inbound_leads.id>",
  "action": "opt_out", "channels": ["sms"], "source": "ghl_stop" }
```

### 2. Contact moved to DND
Map DND scope to channels. GHL "DND: All" → all three; per-channel DND → that channel.
```json
{ "customer_id": "<org>", "external_ref": "<inbound_leads.id>",
  "action": "opt_out", "channels": ["sms","email","voice"], "source": "ghl_dnd" }
```

### 3. Email unsubscribe
```json
{ "customer_id": "<org>", "external_ref": "<inbound_leads.id>",
  "action": "opt_out", "channels": ["email"], "source": "ghl_email_unsub" }
```

### 4. Contact replies YES / opts in / re-subscribes (the conversion event)
Send only the channel(s) the consent actually covers. A bare SMS "YES" = `["sms"]`;
a hosted-page confirm covering both = `["sms","email"]`.
```json
{ "customer_id": "<org>", "external_ref": "<inbound_leads.id>",
  "action": "opt_in", "channels": ["sms"], "source": "ghl_reply_yes" }
```
> `opt_in` also **clears** any prior opt-out for that channel (handles a genuine
> re-subscribe). Only fire it on a real affirmative action by the contact.

---

## Ordering & the 404 case

The lead must exist in LI first (created via `POST /api/v1/leads`). If a consent change
fires for a contact DGS hasn't pushed yet, you'll get `404 lead_not_found`. Handle it by
either: (a) push the lead via `/api/v1/leads` first, then re-send the consent change; or
(b) queue and retry. **Never drop an opt-out silently** — a lost STOP is a TCPA liability.

## What LI does on receipt (FYI)

- `opt_out` → sets the hard `<channel>_opt_out = true` + timestamp. The
  `sync_consent_status` trigger flips status to `declined`; `log_consent_change` appends
  a `consent_log` revoke row. The send-gate now blocks this channel for this lead.
- `opt_in` → sets `<channel>_consent = true` + timestamp + your `source`, clears
  `<channel>_opt_out`; triggers set status `granted` and log the grant.

## Example

```bash
curl -sS -X POST "$LI_BASE_URL/api/v1/consent" \
  -H "Authorization: Bearer $GROWTH_STUDIO_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": "fa64e53c-3d9b-493e-b904-59580cb3f29c",
    "external_ref": "6c4d7383-b59a-499f-9acc-d2fdcaa43dfc",
    "action": "opt_out",
    "channels": ["sms"],
    "source": "ghl_stop",
    "occurred_at": "2026-06-30T18:22:04Z"
  }'
```

## Backfill (one-time)

To reconcile the ~1,000+ existing GHL DND contacts whose opt-out never reached LI:
export GHL's current DND list and POST one `opt_out` per contact (keyed by
`external_ref`). After that, LI's `sms_opt_out` will finally match GHL's DND, and the
re-permission campaign's suppression can trust LI directly instead of re-pulling a fresh
GHL DND export before every batch.
