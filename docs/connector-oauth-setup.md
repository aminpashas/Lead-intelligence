# Connector OAuth Setup — Google Ads, GA4, Meta

One-page checklist to get the "Connect with Google" and "Connect with Meta"
buttons in **Settings → Connectors** working against your real ad accounts.

You only do this once, as the platform owner. Each org that uses Lead
Intelligence after that just clicks "Connect" — they don't need their own
developer accounts.

---

## Prerequisites

- [ ] You have admin access to your Google Ads account (or MCC manager account).
- [ ] You have admin access to the Facebook Business Manager that owns your Pixels and ad accounts.
- [ ] You know your `NEXT_PUBLIC_APP_URL` (e.g. `http://localhost:3000` for dev, `https://app.example.com` for prod).

---

## 1. Google Cloud OAuth client (~10 min)

This single client covers both Google Ads and GA4 — the user grants both scopes in one consent screen.

- [ ] Go to [console.cloud.google.com](https://console.cloud.google.com) → create a new project (e.g. "Lead Intelligence")
- [ ] **APIs & Services → Library** → enable all three:
  - [ ] Google Ads API
  - [ ] Google Analytics Admin API
  - [ ] Google Analytics Data API
- [ ] **APIs & Services → OAuth consent screen**:
  - [ ] User type: **External**
  - [ ] Fill app name, user support email, developer contact email
  - [ ] **Scopes → Add or Remove Scopes**, then add:
    - [ ] `https://www.googleapis.com/auth/adwords`
    - [ ] `https://www.googleapis.com/auth/analytics.readonly`
  - [ ] **Test users**: add your email + anyone else who will click "Connect" while you're in Testing mode
  - [ ] Leave **Publishing status** as `Testing` — caps at 100 connections, no Google review needed. Submit for verification later if you need to scale.
- [ ] **APIs & Services → Credentials → Create credentials → OAuth client ID**
  - [ ] Type: **Web application**
  - [ ] **Authorized redirect URIs** — add both of these:
    - [ ] `http://localhost:3000/api/connectors/oauth/google/callback`
    - [ ] `{your production URL}/api/connectors/oauth/google/callback` (when you have one)
  - [ ] Save → copy the values:
    - [ ] `GOOGLE_ADS_CLIENT_ID` ← Client ID
    - [ ] `GOOGLE_ADS_CLIENT_SECRET` ← Client Secret

---

## 2. Google Ads developer token (~1–3 business days)

This is the slowest step. Start it first.

- [ ] Sign in to the Ads account that will own API access (your MCC manager account if you have one — otherwise your standalone Ads account)
- [ ] Open [ads.google.com/aw/apicenter](https://ads.google.com/aw/apicenter)
- [ ] Apply for **Basic Access**
  - Don't pick Test Access — it's instant but caps at 15k ops/day and can't write to live accounts.
  - Don't apply for Standard Access yet — Basic is enough until you outgrow it.
- [ ] Wait for Google's approval email (1–3 business days).
- [ ] Once approved, copy the token:
  - [ ] `GOOGLE_ADS_DEVELOPER_TOKEN` ← Developer token

**Gotcha:** The dev token is bound to the Ads account you apply from. If
you apply from a child account but your CRM later wants to push
conversions to a sibling account, both must be under the same MCC.

---

## 3. Meta (Facebook) Business app (~10 min)

- [ ] Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create App**
- [ ] Use case: **Other** → type: **Business**
- [ ] **Business portfolio**: link the Business Manager that owns your Pixels and ad accounts. *This is what makes your Pixels visible during the OAuth flow* — don't skip it.
- [ ] **App Settings → Basic** → copy:
  - [ ] `META_APP_ID` ← App ID
  - [ ] `META_APP_SECRET` ← App Secret (click "Show")
- [ ] **Add products → Facebook Login for Business** → set up
- [ ] Inside Facebook Login for Business → **Settings**:
  - [ ] **Valid OAuth Redirect URIs**: add both:
    - [ ] `http://localhost:3000/api/connectors/oauth/meta/callback`
    - [ ] `{your production URL}/api/connectors/oauth/meta/callback`
- [ ] **App Review → Permissions and Features** → request:
  - [ ] `ads_management`
  - [ ] `ads_read`
  - [ ] `business_management`

### Dev mode (what you want right now)
- [ ] **App roles → Roles → Add people** → add yourself as **App Tester**.
- [ ] Anyone else who needs to click "Connect with Meta" while you're in dev mode also needs to be added as an App Tester.

App Testers can grant un-reviewed scopes against live ad accounts. No Meta review required.

### Production (later)
- [ ] Submit each scope for **App Review** — Meta requires a screencast showing how each permission is used. Plan for ~1–2 weeks including revisions.

---

## 4. Drop the values into `.env.local`

```bash
# Required for "Connect with Google"
GOOGLE_ADS_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_ADS_CLIENT_SECRET=GOCSPX-...
GOOGLE_ADS_DEVELOPER_TOKEN=...

# Required for "Connect with Meta"
META_APP_ID=...
META_APP_SECRET=...

# Required for both — used to construct OAuth redirect URIs
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Required for credential encryption at rest (already used for PII).
# If unset: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
ENCRYPTION_KEY=...
```

Then:
```bash
npm run dev
```

---

## 5. Connect your accounts

- [ ] Sign in to Lead Intelligence as an org owner or admin
- [ ] Go to **Settings → Connectors**
- [ ] Click **Connect with Google**
  - Pick your Ads customer + GA4 property in the picker
  - Paste your GA4 Measurement Protocol API Secret (from GA4 Admin → Data Streams → [stream] → Measurement Protocol API secrets)
- [ ] Click **Connect with Meta**
  - Pick your ad account + Pixel
  - (Optional) Set a Test Event Code for Events Manager test mode
- [ ] Hit **Test** on each card to verify a synthetic event lands in the destination platform

---

## Troubleshooting

| Error code on the banner | What to do |
|--------------------------|------------|
| `not_configured:...` | Env var missing — double-check `.env.local` and restart dev server |
| `google_oauth_no_refresh_token` | You've previously authorized this app in your Google account — go to [myaccount.google.com/permissions](https://myaccount.google.com/permissions), remove the app, retry |
| `meta_oauth_denied:...` | User declined a scope or isn't an App Tester (in dev mode) — add them in **App roles → Roles** |
| `google_oauth_state_expired` | Picker page sat open >30 min — click Connect again |
| Ads listing failed | Dev token not approved yet, or the connecting Google user has no Ads access |
| GA4 listing failed | Connecting user has no GA4 access on any property |

---

## Token expiry

- **Google refresh token** — long-lived. Doesn't expire unless the user revokes access in their Google account, or it goes 6 months unused.
- **Meta access token** — ~60 days. The picker UI shows the expiry date. You'll need to click "Reconnect with Meta" before then. Auto-refresh cron is on the roadmap.

---

## Where credentials live

- Env vars (this doc) — platform-wide OAuth client + dev token
- `connector_configs.credentials` (Postgres, AES-GCM encrypted) — per-org refresh tokens, customer IDs, Pixel IDs
- `connector_configs.settings` — per-org public identifiers (property ID, ad account ID, token expiry timestamp)

Encryption key is `ENCRYPTION_KEY` (same one used for PII). Rotating it requires re-saving every connector — there's no automated rotation tool yet.
