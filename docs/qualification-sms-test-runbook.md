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
| QA campaign | `4830baa7-578a-476e-8c2d-d9033da29dd3` ("QA — Qualification Test (Amin only)") |

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

> Inbound routing note: the number `+14158861942` belongs to the Messaging Service
> with `use_inbound_webhook_on_number: false`, so the SERVICE-level
> `inbound_request_url` (production host `lead-intelligence-jet.vercel.app`) wins —
> the stale preview URL configured on the number itself is ignored.

### ⚠️ The AI reply is campaign-gated (deny-by-default)

The autopilot reply sends with caller `autopilot.auto_respond`, which
`assertCampaignSendAllowed` (`src/lib/campaigns/send-authorization.ts`) only allows
when the lead's **last-touch ACTIVE campaign enrollment** points at a campaign with
`send_mode='live'`. No active enrollment → the AI still generates a reply, but the
send is refused with `campaign_not_authorized` and the thread is escalated to a
human — which looks like **"nothing happens"** on the phone. (Cross-channel email
is NOT behind this SMS gate, so you may get an AI email while the SMS is blocked.)

For the Amin test lead this is satisfied by the isolated QA campaign
**"QA — Qualification Test (Amin only)"** — active / `ai_enabled: true` /
`autopilot_mode: 'auto'` / `send_mode: 'live'` — with ONLY the Amin lead enrolled
(created 2026-07-12). If replies stop working again, first check that this
enrollment is still `active` and the campaign is still `active` + `live`.

Other state that must hold for auto-replies (all verified 2026-07-12): lead
`ai_autopilot_override='force_on'`, `sms_opt_out=false`; SMS conversation
`ai_enabled=true`, `ai_mode='auto'`; org autopilot enabled and not paused.
Diagnose failures via `lead_activities` (look for `escalated_to_human` rows with
the deny reason in the description) and the `escalations` table.
