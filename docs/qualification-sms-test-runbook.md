# Qualification-via-Text Test Runbook (Amin test patient)

Operator guide to exercise the **AI lead-qualification SMS** path end-to-end for the
Amin Samadian test lead in **Dion Health San Francisco**.

> Everything funnels through `sendSMSToLead` → the same gate chain the inbound
> webhook + autopilot use: campaign authorization → consent (TCPA) → compliance
> filter → TCPA quiet-hours → **US A2P 10DLC gate (`us_sms_enabled`)** → verified
> Messaging Service. A `{ sent: true }` result means every gate passed.

## Fixed identity

| Field | Value |
|---|---|
| Org (Dion Health SF) | `fa64e53c-3d9b-493e-b904-59580cb3f29c` |
| Amin lead id | `62e839ba-90ea-4e77-bcb8-68d5172a2e6b` |
| Phone (E.164) | `+14156767420` |
| Consent | `sms_consent: true` (source `self_opt_in_go_live_test`) |

## Safety clamps (all enforced at the lowest choke point in `twilio.ts`)

1. `MESSAGING_DRY_RUN` — when set, **nothing** physically sends. Must be **unset** to send.
2. `TEST_SEND_ALLOWLIST` — must contain `+14156767420`; every non-allowlisted
   recipient is hard-refused. Keep this set while testing.
3. `us_sms_enabled` org flag — **fail-closed**. If OFF, US SMS is blocked and the
   send returns `{ sent: false, reason: … }` (no text leaves). Flip on only after
   10DLC is VERIFIED in Twilio.

## Steps (run from `~/Lead Intelligence`)

```bash
# 1. Seed / confirm the Amin test lead (idempotent, consent recorded)
npx tsx scripts/add-test-patient.ts

# 2. (optional) Prove raw Twilio delivery before the gated AI path
npx tsx scripts/test-sms.ts +14156767420

# 3. AI qualification opener through the FULL gated path (aiGenerated=true)
npx tsx scripts/test-qualification-sms-amin.ts
```

- `{ sent: true, sid, status }` → gate open, real qualification text delivered to +1 415 676 7420.
- `{ sent: false, reason: 'us_sms_blocked' }` (or similar) → A2P gate still closed;
  verify the 10DLC campaign in Twilio and flip `us_sms_enabled` on, then re-run.

## Continue the conversation (inbound leg)

Reply to the text from your phone → Twilio POSTs `/api/webhooks/twilio` (signature-
validated) → the AI qualification reply loop runs. This requires the deployed LI app
with the Twilio inbound webhook URL wired in the Twilio console.
