# Retell hosted-agent setup — `verify_identity`

The HIPAA identity gate (see `src/lib/ai/identity-verification.ts`) is enforced in
code for SMS/email and for any voice path that runs through
`processVoiceTranscript`. The **live phone agent runs on Retell's hosted LLM**
(`llm_feecac`), so it does not pick up repo changes automatically — the
`verify_identity` function and the verification prompt block must be added in
Retell for phone calls to enforce the gate.

The backing endpoint already ships in this repo:
`POST /api/voice/tools/verify-identity` (reuses `verifyDob`, verifies the Retell
signature, writes `conversations.identity_verified_at`, fails closed).

## 1. Add the function

`<APP_DOMAIN>` = the exact host your existing Retell webhook already uses for
`/api/voice/webhook` (Retell → agent → Webhook URL). Reuse that origin — do not
invent a new domain.

```json
{
  "type": "custom",
  "name": "verify_identity",
  "description": "Confirm the caller is really this patient BEFORE sharing any appointment time, treatment plan, cost, financing/credit, or insurance detail. Ask for their date of birth, then call this with exactly what they said. Returns whether it matched what is on file. Only discuss case-specific details after this returns verified. If it does not match, do not share details — offer to have a team member call them back at the number on file. You may still greet them by first name, answer general questions, and book a consultation without verifying.",
  "url": "https://<APP_DOMAIN>/api/voice/tools/verify-identity",
  "speak_during_execution": true,
  "execution_message_description": "Say something brief and natural while you check, e.g. 'Let me just pull up your file real quick.'",
  "speak_after_execution": true,
  "timeout_ms": 8000,
  "parameters": {
    "type": "object",
    "properties": {
      "date_of_birth": {
        "type": "string",
        "description": "The date of birth the patient stated, in whatever format they said it (e.g. 'March 5 1980' or '3/5/1980')."
      }
    },
    "required": ["date_of_birth"]
  }
}
```

### Attaching via API (alternative to the dashboard form)

`general_tools` is a **whole-array replace**, not a merge. Fetch the current
tools first and re-send them plus this one, or you will silently drop
`end_call` / `transfer` and break the live agent.

```bash
# 1. Read current tools (do NOT skip this)
curl -s https://api.retellai.com/get-retell-llm/llm_feecac \
  -H "Authorization: Bearer $RETELL_API_KEY" | jq '.general_tools'

# 2. PATCH with the FULL array = existing tools + verify_identity
curl -X PATCH https://api.retellai.com/update-retell-llm/llm_feecac \
  -H "Authorization: Bearer $RETELL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "general_tools": [ <EXISTING TOOLS>, { ...verify_identity above... } ] }'
```

## 2. Add the prompt block

The function does nothing unless the prompt tells the agent to call it before
disclosing. Add this to the agent's general prompt:

```
═══ IDENTITY VERIFICATION (MANDATORY) ═══
Before revealing or confirming ANY appointment time, treatment plan, cost,
financing/credit, or insurance detail, you must confirm the caller is the patient.
Ask for their date of birth, then call the verify_identity function with what they say.
Only after it returns verified may you discuss case-specific details.
If it does not match, do not share details — offer to have a team member call them
back at the number on file. You MAY greet them by first name and book a consultation
without verifying.
```

## 3. Requirements & behavior

- **Call metadata must carry `lead_id`, `conversation_id`, `organization_id`.**
  The endpoint reads them from `call.metadata` (same source `/api/voice/webhook`
  uses); the outbound/inbound flow already sets them. A call with no metadata
  returns `verified: false` (fail-closed).
- The endpoint returns `{ verified: boolean, message: string }`; with
  `speak_after_execution: true` the agent responds from `message`.
- Verification is session-scoped and time-boxed (voice TTL 15 min, see
  `VERIFICATION_TTL_MS`). Re-verification is required after it lapses.
- This mirrors the repo-side `verify_identity` tool in
  `src/lib/autopilot/agent-tools.ts` — same DOB logic, same conversation flag.
