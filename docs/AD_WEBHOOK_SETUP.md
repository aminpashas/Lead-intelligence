# Direct Ad-Lead Webhooks — Platform Go-Live Guide

The code for direct Meta Lead Ads and Google Ads Lead Form ingestion is live on
main (`src/app/api/webhooks/meta`, `src/app/api/webhooks/google-ads`). Nothing
fires until each platform is pointed at us and the credentials below are set.
This guide is the exact turn-on procedure.

Why we want this: these webhooks are the ONLY lead source that carries real ad
attribution (campaign/form ids), rich form fields, and consent-at-source. The
DGS/WhatConverts and GHL feeds carry none of that (fbclid=0 across the entire
historical book).

## Credential resolution (both platforms)

Each webhook reads per-org `connector_configs.credentials` first (AES-GCM
encrypted; connector types `meta_capi`/`meta` and `google_ads`), then falls
back to env vars. Until the connectors UI grows fields for these, **set the
env vars in Vercel** (Production scope):

| Env var | Used for | Where the value comes from |
| --- | --- | --- |
| `META_APP_SECRET` | HMAC-SHA256 verification of every Meta POST (`x-hub-signature-256`) | Meta App → Settings → Basic → App Secret |
| `META_PAGE_ACCESS_TOKEN` | Graph API `GET /{leadgen_id}` — the webhook payload does NOT include the form answers; without this token non-relay leads are ack'd but skipped | Page access token for the Facebook Page running lead ads (System User token recommended, it doesn't expire like user tokens ~60d) |
| `META_VERIFY_TOKEN` | Meta's one-time GET subscription handshake | Self-chosen random string (falls back to `WEBHOOK_SECRET` if unset) |
| `GOOGLE_LEAD_FORM_KEY` | In-body `google_key` auth on every Google POST (Google sends no HMAC header) | Self-chosen random string; you type the same value into each Google lead form asset |

Generate the two self-chosen values with `openssl rand -hex 24`.

The org UUID for the webhook URLs: Supabase → `organizations.id` for the
practice (or the `org` query param visible in existing form-webhook URLs).

---

## Meta Lead Ads

Webhook URL: `https://<LI_PROD_DOMAIN>/api/webhooks/meta?org=<ORG_UUID>`

1. **App**: use the existing Meta app (the one whose `META_APP_ID`/`META_APP_SECRET`
   power the CAPI OAuth flow). It needs the `leads_retrieval` and
   `pages_manage_metadata` permissions (App Review required for prod unless the
   connecting user is an app Admin/Tester on the ad account's Business).
2. **Page token**: create a System User in Business Manager → assign the
   Facebook Page → generate a token with `leads_retrieval` + `pages_show_list`
   + `pages_manage_metadata`. Set it as `META_PAGE_ACCESS_TOKEN`.
3. **Webhook subscription**: App Dashboard → Webhooks → **Page** object →
   Subscribe → Callback URL = the URL above, Verify Token = `META_VERIFY_TOKEN`
   value → Meta sends `GET ...&hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`;
   our route echoes the challenge when the token matches.
4. **Subscribe the Page to the app** with the `leadgen` field:
   App Dashboard → Webhooks → Page → subscribe to `leadgen`, AND the Page itself
   must have the app installed (Graph API: `POST /{page-id}/subscribed_apps?subscribed_fields=leadgen`
   with the page token).
5. **CRM connection status** (optional but recommended): in Meta Lead Ads
   settings, verify the form shows a connected CRM so lead delivery health is
   visible in Ads Manager.

Behavior notes:
- Signature: with `META_APP_SECRET` set, every POST must carry a valid
  `x-hub-signature-256` (HMAC of the raw body keyed by the App Secret).
- Consent: parsed conservatively from the form's consent/checkbox fields
  (`detectMetaConsent`) — never fabricated. Leads without a consent answer land
  consent-unknown (re-permission pool).
- Leads with no fetchable answers (missing page token) are ack'd 200 but
  skipped — Meta would otherwise retry and eventually disable the subscription.
- Dedup: shared `ingestLead` (hash-based on phone/email) — re-delivered
  webhooks don't duplicate leads.

### Smoke test

```bash
# 1. Handshake (expects the challenge echoed back, HTTP 200):
curl -s "https://<LI_PROD_DOMAIN>/api/webhooks/meta?org=<ORG_UUID>&hub.mode=subscribe&hub.verify_token=<META_VERIFY_TOKEN>&hub.challenge=ping123"
# → ping123

# 2. Wrong token (expects 403):
curl -s "https://<LI_PROD_DOMAIN>/api/webhooks/meta?org=<ORG_UUID>&hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x"

# 3. Real lead: use Meta's Lead Ads Testing Tool
#    (https://developers.facebook.com/tools/lead-ads-testing) against the
#    subscribed Page — it fires a real leadgen webhook with a test lead.
#    Then confirm a lead row exists with source_type='meta_ads', tags=['meta'].
```

---

## Google Ads Lead Form

Webhook URL: `https://<LI_PROD_DOMAIN>/api/webhooks/google-ads?org=<ORG_UUID>`

1. In Google Ads → Assets → Lead forms → open each lead form asset (or create
   one on the campaign).
2. Under **Lead delivery option → Webhook integration**:
   - Webhook URL = the URL above
   - Key = the `GOOGLE_LEAD_FORM_KEY` value
3. Click **Send test data** — Google POSTs a payload with `is_test: true`; our
   route acks `{"success":true,"action":"test_ignored"}` and creates nothing.
   Google shows the delivery as successful.
4. Repeat for every lead form asset (the key is per-form in Google's UI; use
   the same value everywhere — the route has one key per org).

Behavior notes:
- Auth is the in-body `google_key` (constant-time compare). Google does not
  sign lead-form webhooks — the key IS the secret; treat it like one.
- Consent is left **unknown** (Google forms carry no standard consent signal;
  the shared ingest never fabricates consent). These leads are worked via the
  re-permission flow.
- `gclid` is captured when present → real click attribution.
- Test leads (`is_test`) are always ignored; dedup via shared `ingestLead`.

### Smoke test

```bash
# 1. Test payload (expects test_ignored):
curl -s -X POST "https://<LI_PROD_DOMAIN>/api/webhooks/google-ads?org=<ORG_UUID>" \
  -H "Content-Type: application/json" \
  -d '{"google_key":"<GOOGLE_LEAD_FORM_KEY>","is_test":true,"user_column_data":[]}'
# → {"success":true,"action":"test_ignored"}

# 2. Wrong key (expects 401):
curl -s -X POST "https://<LI_PROD_DOMAIN>/api/webhooks/google-ads?org=<ORG_UUID>" \
  -H "Content-Type: application/json" \
  -d '{"google_key":"wrong","is_test":true}'

# 3. Synthetic real lead (expects 201 + action:"created"; clean up after):
curl -s -X POST "https://<LI_PROD_DOMAIN>/api/webhooks/google-ads?org=<ORG_UUID>" \
  -H "Content-Type: application/json" \
  -d '{"google_key":"<GOOGLE_LEAD_FORM_KEY>","lead_id":"smoke-1","campaign_id":"123",
       "user_column_data":[
         {"column_id":"FULL_NAME","string_value":"Webhook Smoketest"},
         {"column_id":"EMAIL","string_value":"smoketest@example.com"},
         {"column_id":"PHONE_NUMBER","string_value":"+14155550100"}]}'
```

---

## Go-live checklist

- [ ] `openssl rand -hex 24` twice → `META_VERIFY_TOKEN`, `GOOGLE_LEAD_FORM_KEY`
- [ ] Vercel (Production): set `META_APP_SECRET`, `META_PAGE_ACCESS_TOKEN`,
      `META_VERIFY_TOKEN`, `GOOGLE_LEAD_FORM_KEY`; redeploy
- [ ] Meta: webhook subscription (Page/leadgen) + Page subscribed_apps + handshake OK
- [ ] Google: webhook URL + Key on every lead form asset; "Send test data" OK
- [ ] Smoke tests above pass against prod
- [ ] One real test lead per platform → lead row with attribution
      (`utm_campaign`/`gclid`/`custom_fields.meta_lead_id`) and correct consent
- [ ] Watch the first day of volume: `select source_type, count(*) from leads
      where created_at > now() - interval '1 day' group by 1`
