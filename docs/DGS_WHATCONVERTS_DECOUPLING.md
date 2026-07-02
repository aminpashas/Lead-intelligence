# Decoupling from DGS + dropping GHL — plan

_Grounded in a prod audit on 2026-07-02 (project `bnmnirzfwopqklsitjgq`)._

## The actual lead architecture (not "GHL → LI")

Leads reach LI through **three independent feeds**. GHL is the smallest.

| Feed | How | Volume (7d) | Depends on |
|---|---|---|---|
| **DGS bridge** `/api/v1/leads` | Sibling Vercel project (dion-growth-studio) POSTs with a service key | WhatConverts ~10.7k + GHL-mirror ~0.7k | **DGS** |
| **Native GHL cron** `/api/cron/ghl-sync` | LI pulls the GHL API every 15 min | ~243 (`ghl_full_arch_cold`) | GHL |
| **Direct webhooks** `/api/webhooks/{meta,google-ads}` | Ad platform → LI | ~0 | — |

**~96% of volume flows through DGS**, not GHL. "Leads land directly in LI" is not true today for almost anything.

## The attribution problem (why direct webhooks matter)

Across all 45,140 leads:

- `fbclid` = **0** — zero Meta click attribution, ever.
- `gclid` < 1%. `utm_campaign` ≈ 0.
- WhatConverts is 92% phone-only / 88% no-email (thin call-tracking records).

The DGS/WhatConverts path does **not** deliver ad attribution. The direct Google/Meta
webhooks are the only source of real attribution + rich form fields + consent-at-source.
**Dropping GHL does not get you attribution — the direct webhooks do.**

## Consent

1 of 45,140 leads is textable (`sms_consent`). The whole existing book needs the
re-permission campaign regardless of source. **New** direct-webhook leads carry
consent going forward (Meta form-consent detection is built; Google has no signal → unknown).

---

## Workstreams

### A. Drop GHL — low risk, do first
- WhatConverts is unaffected (it's DGS, not GHL). Native GHL cron = ~243/wk.
- The 33,527 historical `gohighlevel` leads are already persisted in LI and static.
- **Caveat:** the ~0.7k/wk `gohighlevel` leads arriving via DGS are GHL-*mirrored* — if the GHL *platform* is switched off at source, DGS has nothing to mirror and those stop. Confirm those leads originate elsewhere (or are acceptable to lose) before turning GHL off at the platform.
- Mechanics: delete `src/lib/ghl/*`, the `ghl-sync` entry in `vercel.json`, the GHL connector card; re-author pipeline stages as LI-owned (GHL currently auto-mirrors them via `stage-map.ts`). Existing leads keep their `stage_id`.

### B. Direct ad ingestion — the real goal
- **Meta:** ✅ code done (`feat/direct-ad-lead-ingestion`). External: Meta App + long-lived Page token + `leadgen` subscription → `/api/webhooks/meta?org=<org>`; store `app_secret` + `page_access_token` in the `meta_capi` connector creds (or env).
- **Google:** ✅ code done (same branch). External: set the webhook URL + **Key** on each Google lead form; store that as `lead_form_key` in the `google_ads` connector creds (or `GOOGLE_LEAD_FORM_KEY`).

### C. Decouple WhatConverts from DGS — the "drop the middleman" decision
WhatConverts is call/form tracking. Two options:

1. **Build a native `/api/webhooks/whatconverts` receiver** (mirror the CallRail pattern:
   per-org token in `connector_configs`, no HMAC). WhatConverts "Lead Notifications"
   POST directly to LI; map its payload → shared `ingestLead`. Removes DGS from the
   highest-volume path. **Recommended if the goal is true direct-to-LI.**
2. **Keep DGS as the WhatConverts puller.** DGS already does the 90-day re-pull + dedup.
   Lower effort, but you stay dependent on the sibling project and its attribution
   fidelity (which is currently poor — see above).

Note: even with option 1, WhatConverts leads remain thin (phone-only, no ad attribution).
The rich Google/Meta attribution comes from workstream **B**, not from WhatConverts.

---

## Recommended sequence
1. **B** — turn on the direct Meta + Google webhooks (external config). This is what the
   original goal actually needs and is already built.
2. **A** — drop GHL (after confirming the DGS `gohighlevel` mirror leads are expendable
   or sourced elsewhere).
3. **C** — decide WhatConverts: build the native receiver (option 1) to fully remove DGS,
   or consciously keep DGS for call-tracking only.
4. Re-permission campaign for the existing 45k book (separate track, already scoped).
