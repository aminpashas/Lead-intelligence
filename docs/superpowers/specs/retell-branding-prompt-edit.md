# Retell hosted-prompt edit — brand-aware greeting

**Manual step.** The live voice agent's words live in the Retell dashboard, not in
this repo. The repo now *sends* the brand variables; this doc is the dashboard
edit that makes the agent *say* them. Apply it in Retell — it does not deploy
from code.

## What the repo now sends

On **both inbound and outbound** calls, `retell_llm_dynamic_variables` now includes:

| Variable | Meaning | Can be empty? |
|---|---|---|
| `{{practice_name}}` | The brand for this lead's service line (e.g. "Dion Health", "San Francisco Center for TMJ and Sleep Apnea", "SF Dentistry") | No — always a non-empty name (falls back to the org name) |
| `{{doctor_name}}` | Provider to name, e.g. "Dr. Amin Samadian" | **Yes** — empty for general dentistry (SF Dentistry) |
| `{{brand_website}}` | The brand's site, e.g. "dionhealth.com" | Yes |

- Inbound agent id: `agent_d5891af66aa9f7a83b9f96fc3a`.
- Outbound agent id: the value of `RETELL_OUTBOUND_AGENT_ID` (check the deployment env).

## Prompt edits (Retell supports `{{#var}}…{{/var}}` conditionals)

**Outbound opener** — update the greeting so it names the brand, and the doctor
*only when present*:

> "Hi {{caller_first_name}}, this is the patient coordinator calling from
> {{practice_name}}{{#doctor_name}}, the office of {{doctor_name}}{{/doctor_name}}."

**Inbound opener:**

> "Thanks for calling {{practice_name}}{{#doctor_name}}, the office of
> {{doctor_name}}{{/doctor_name}}. This is the patient coordinator — how can I help?"

## Rules to keep in the prompt

- **Name the doctor ONLY when `{{doctor_name}}` is non-empty.** General dentistry
  (SF Dentistry) sends it empty — never invent or infer a provider name.
- Keep the existing "the coordinator never shares a personal name" behavior for
  the coordinator persona itself — `{{doctor_name}}` names the *provider*, not
  the coordinator.
- If you reference the website, use `{{brand_website}}` verbatim (may be empty).

## Verification after applying

Place one test call for a TMJ-signalled lead and one for a lead with no service
signal:
- TMJ lead → agent says "San Francisco Center for TMJ and Sleep Apnea, the office
  of Dr. Amin Samadian".
- No-signal lead → agent says "SF Dentistry" with **no** "office of…" clause.

(Voice is currently off in prod per the messaging hard-stop; run this when voice
is re-enabled.)
