# Live-Transfer Setup Runbook (AI-mediated warm transfer)

Goal: an app-placed **Retell AI** call to a lead that, mid-call, hands the caller to
a **live person** (e.g. Heather) via the transfer broker. This is the production
path that `scripts/test-call-forward-amin.ts` (a plain Twilio forward) stands in for.

Org: **SF Dentistry** `fa64e53c-3d9b-493e-b904-59580cb3f29c`.

## How it works

1. `initiateOutboundCall` (or the campaign dialer) places a Retell call and passes
   `live_transfer=true` + a `transfer_mode`.
2. Mid-call the Retell agent invokes a **custom function** → `POST /api/voice/transfer`.
3. The broker checks `organizations.voice_live_transfer_enabled`, resolves the active
   `voice_transfer_route` for "now", claims a free `voice_transfer_target`, and returns
   that target's PSTN number. The agent bridges to it with its `transfer_call` tool.

## Already done (this session)

- ✅ `voice_transfer_targets` → **Heather** `9598ae27-97a5-4efc-b065-fcf3ba16d6dd`
      (kind `phone`, destination `+18058889879`, active, on_duty).
- ✅ `voice_transfer_routes` → **All hours → Heather** `bfd0547b-30a8-4a63-98eb-68ee9900a438`
      (24/7, `America/Los_Angeles`, targets = [Heather]).
- ✅ `voice_agent_presence` → Heather `available`.
- ✅ `VOICE_TRANSFER_FUNCTION_SECRET` (value NOT in this doc — see `.env.local`
      + Vercel production env) set in `.env.local` **and Vercel production**
      (replaced a prior empty value).
      ⚠️ Env changes only take effect on the next production **redeploy**.
- ✅ Org already has `voice_retell_agent_id = agent_d5891af66aa9f7a83b9f96fc3a`,
      caller ID `+14158861942`, recording on.

**All config above is INERT** until the org toggle is flipped — the broker returns
"wrap up" while `voice_live_transfer_enabled = false`.

## Remaining steps (require external access / decisions)

### 1. ✅ Broker secret in PRODUCTION — DONE
Set in Vercel production this session (was an empty `""`). **Redeploy production**
so running functions pick it up.

### 2. Wire the Retell hosted LLM (do this AT go-live, not before)

The live agent `agent_d5891af66aa9f7a83b9f96fc3a` = **"Lead Intelligence Setter"**,
response engine `retell-llm` → hosted LLM **`llm_feecac282805840957d20b5806b3`**
(model `claude-4.5-sonnet`, currently v5). It serves **real inbound SF Dentistry
calls**. It currently has NO transfer tool. Existing general_tools: `end_call`,
`check_availability`, `book_appointment`, `update_contact`, `verify_identity`.

⚠️ Do NOT add the transfer wiring while `voice_live_transfer_enabled = false`: the
broker returns `wrap_up`, so the agent would offer a transfer it can't complete —
degrading real callers. Add this in the SAME change window as flipping the toggle.

Add two tools to the hosted LLM (`PATCH /update-retell-llm/{llm_id}`, or the
dashboard). Point the custom tool at the STABLE host + send the secret as a header:

```jsonc
// general_tools += 
{
  "type": "custom",
  "name": "request_transfer",
  "description": "Ask the CRM whether a live specialist is available. Call this when the caller wants a human. Returns {available, action, transfer_to, say}.",
  "url": "https://lead-intelligence-jet.vercel.app/api/voice/transfer",
  "headers": { "x-transfer-secret": "<VOICE_TRANSFER_FUNCTION_SECRET>" },  // pull from env, do not hardcode
  "speak_during_execution": true
},
{ "type": "transfer_call", "name": "transfer_call" }
```

Prompt addition: "If the caller asks for a person / wants to be connected, call
`request_transfer`. If it returns action=`transfer`, say its `say` line then call
`transfer_call` with `transfer_to`. If `hold`, keep qualifying and call
`request_transfer` again shortly. If `wrap_up`, book or take a message."

(The outbound `initiateOutboundCall` path also passes `{{live_transfer}}` /
`{{transfer_mode}}` dynamic vars the prompt can branch on for AI-placed calls.)

### 3. Flip the org toggle(s) — PRODUCTION BEHAVIOR CHANGE
- `voice_live_transfer_enabled = true` → **every** inbound AI call to SF Dentistry
  that asks for a human will forward to Heather's cell 24/7 (not just tests). The
  24/7 route is deliberately broad for testing; scope `active_days`/hours or set the
  target `on_duty=false` to pause.
- `voice_enabled = true` → enables **AI outbound** org-wide (currently `false`).
  Needed for an app-placed AI test call; leave off if you only want inbound transfer.

### 4. Outbound telephony permission (known blocker)
Past outbound Retell attempts for this org failed with
`telephony_provider_permission_denied`. Outbound AI dialing needs the Retell↔Twilio
trunk configured (Retell `/v2` endpoint + Twilio SIP termination IP ACL). Inbound
transfer works without this.

## Rollback
```sql
update organizations set voice_live_transfer_enabled=false, voice_enabled=false
where id='fa64e53c-3d9b-493e-b904-59580cb3f29c';
-- or pause just the target:
update voice_transfer_targets set on_duty=false where id='9598ae27-97a5-4efc-b065-fcf3ba16d6dd';
```
