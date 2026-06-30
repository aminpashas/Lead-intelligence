# Cold Full-Arch Reactivation — Go-Live Runbook

Operator guide to turn on the re-permission → AI-voice reactivation of the ~488 cold
full-arch leads. The whole system is **built and dark**; this is the ordered switch list.

> **Pipeline:** import 488 (tag `full-arch-cold`, consent `unknown`) → daily cron emails
> the voice-inclusive opt-in → lead taps "yes" → grants email + SMS + voice consent
> (audited) → AI voice (Retell) + SMS legally work the consented subset.

---

## 0. Credentials you'll need

| Secret | Used for |
|---|---|
| `GHL_API_TOKEN` + `GHL_LOCATION_ID` | importing the 488 from the GHL Full-Arch pipeline |
| LI `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `ENCRYPTION_KEY` | writing leads into LI (PII encrypted) |
| `LI_ORG_ID` | the Dion Health org id in the LI project |
| `RETELL_API_KEY` + `voice_retell_agent_id` | the AI-voice leg (only after opt-ins land) |

---

## 1. Import the 488 (dry-run first)

```bash
GHL_API_TOKEN=… GHL_LOCATION_ID=… LI_ORG_ID=… \
NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… ENCRYPTION_KEY=… \
npx tsx scripts/import-ghl-full-arch-cold.ts                 # DRY RUN — prints stage match + counts
# review the matched cold stages + count, then:
… DRY_RUN=false npx tsx scripts/import-ghl-full-arch-cold.ts # inserts, hash-deduped, idempotent
```
Leads land tagged `full-arch-cold` with **all consent `unknown`** (nothing granted yet).

## 2. Check readiness (read-only)

```bash
LI_ORG_ID=… NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
npx tsx scripts/consent-capture-readiness.ts
```
Reports the consent_capture flag, lead counts, how many are opt-in-eligible (have email),
voice config, and A2P status — a single go/no-go.

## 3. ⚠️ Legal / compliance gate — HARD BLOCKERS (do not skip)

These are the playbook's non-negotiables (`docs/re-permission-campaign-playbook.md`):
- [ ] **TCPA counsel sign-off** on the opt-in disclosure (automated/AI calls + texts) and the
      prior-inquiry basis, in your jurisdictions.
- [ ] **DNC scrub** — National DNC + applicable state lists, dated proof retained per number,
      before any phone contact.
- [ ] **Email auth** — SPF, DKIM, DMARC aligned + passing on the Resend sending domain.
- [ ] **STOP / HELP + opt-out sync** tested on prod (reply STOP → suppression writes to LI
      `*_opt_out` and the email track honors it).

## 4. Flip the switches (per-org flag + global send)

- Set org `feature_flags.consent_capture = true` (Dion org).
- Set the org's mailing address: confirm the `practice_info` content asset has
  address/city/state/zip, **or** set env `CONSENT_FOOTER_POSTAL_ADDRESS` (CAN-SPAM footer).
- Set env **`CONSENT_CAPTURE_SEND=true`** — the master send switch. Until this is `true` the
  daily cron DRY-RUNS (reports who it would email, sends nothing).
- Optional: `CONSENT_CAPTURE_DAILY_CAP` (default 250) for the email warmup ramp.

The cron runs daily (`0 17 * * *`); it emails up to the daily cap, skips declined/opted-out,
and won't re-email a lead within 30 days.

## 5. Warm up + monitor

- Start small (cap ~50–250/day), watch bounce/spam/opt-out, ramp per the playbook.
- Kill criteria: STOP/unsub spike, delivery < 90%, any spam-complaint surge → set
  `CONSENT_CAPTURE_SEND=false` (instant pause).

## 6. Voice activation (after opt-ins start landing)

Once leads begin confirming (they now carry `voice_consent=true` with a logged artifact):
- Set `RETELL_API_KEY`, org `voice_retell_agent_id`, org `voice_enabled=true`.
- The voice agent's `preCallCheck` will only dial leads with granted voice consent — opted-in
  leads only. (US SMS additionally needs the `us_sms_enabled` flag after 10DLC VERIFIED.)

## Rollback

- **Pause sends:** `CONSENT_CAPTURE_SEND=false` (or flip `consent_capture` off). No new opt-in
  emails go out; nothing else is affected.
- Imported leads are inert without the flags — they just sit tagged with `unknown` consent.

## Verification queries (LI Supabase)

```sql
-- how many cold leads loaded, and how many are opt-in-eligible
select count(*) filter (where 'full-arch-cold' = any(tags))                              as cold_total,
       count(*) filter (where 'full-arch-cold' = any(tags) and email is not null
                          and email_opt_out is not true and email_consent_status <> 'declined') as eligible
from leads where organization_id = '<LI_ORG_ID>';

-- opt-in funnel
select status, count(*) from consent_capture_tokens
where organization_id = '<LI_ORG_ID>' group by status;

-- consents earned (the real outcome)
select count(*) from leads
where organization_id = '<LI_ORG_ID>' and voice_consent = true;
```
