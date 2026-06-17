# A2P 10DLC message_flow — v2 (SUBMITTED 2026-06-17, status IN_PROGRESS)

> Resubmitted 2026-06-17T17:42Z via `scripts/a2p-resubmit-v2.py` (DELETE 204 → POST 201).
> Campaign back to IN_PROGRESS in carrier vetting, no errors. SID unchanged
> (`QE2c6890…`, deterministic per Messaging Service). Monitor manually — poll the
> Compliance/Usa2p endpoint until VERIFIED or FAILED.

Campaign: `QE2c6890da8086d771620e9b13fadeba0b` (Messaging Service `MGf6d04811cd838cad5cbb51b9b3d42c6b`, Brand `BNcd0b132357f0fee26e1190b6c7b7a350`)

## Why v2
v1 was rejected twice with **30882 (Terms & Conditions / MESSAGE_FLOW)**. Root cause (verified live 2026-06-16): v1's quoted consent checkbox ended with "...HELP for help. **See our Messaging Terms and Privacy Policy.**" but NEITHER live form's SMS Consent checkbox actually contains that link — on both sfdentistry.com and tmjandsleepapneasanfrancisco.com the label stops at "...HELP for help." The registered flow asserted a T&C link in the consent CTA that isn't there → reviewer flags T&C mismatch.

v2 fixes this two ways: (1) the quoted checkbox text now matches the live form exactly; (2) the Messaging Terms + Privacy Policy are described where they actually live (footer of every page) and given as **absolute URLs** per site so the reviewer never has to infer the domain.

## v2 message_flow text (copy verbatim into the resubmit payload)

Patients opt in to SMS by submitting the contact / appointment-request form at https://www.sfdentistry.com/contact/ or https://www.tmjandsleepapneasanfrancisco.com/contact/. Each form contains a dedicated "SMS Consent" checkbox that is unchecked by default, separate from the "I accept the Terms and Conditions" checkbox, and NOT required to submit the form (consent is optional). The SMS Consent checkbox reads: "By checking this box, I agree to receive text messages from Dion Health about appointment scheduling, reminders, and treatment follow-ups at the mobile number provided. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help." (the practice name — Samadian Cosmetic & Advanced Dentistry, or TMJ & Sleep — appears in parentheses after "Dion Health"). The Messaging Terms and Privacy Policy are linked in the footer of every page on both sites and are available at https://www.sfdentistry.com/sms-terms/, https://www.sfdentistry.com/privacy-policy/, https://www.tmjandsleepapneasanfrancisco.com/sms-terms/, and https://www.tmjandsleepapneasanfrancisco.com/privacy-policy/. The Privacy Policy states that mobile information and SMS opt-in data are never shared with, sold to, or rented to third parties or affiliates for marketing or promotional purposes. Consent is captured per individual at form submission and stored on that patient's record. No opt-in data is purchased, rented, or shared. Patients may also opt in by replying START or YES, and may opt out anytime by replying STOP.

## Optional stronger fix (Wasif, both forms)
Add "See our Messaging Terms and Privacy Policy" with links to /sms-terms/ and /privacy-policy/ INTO the SMS Consent checkbox label on both GHL contact forms. Then v1's wording becomes accurate AND the consent CTA itself carries the T&C links (CTIA best practice). If this is done, the checkbox quote in the flow can keep the "See our Messaging Terms and Privacy Policy." sentence.

GHL survey IDs:
- sfdentistry.com → `70F582taqk1TlAtdwcDd`
- tmjandsleepapneasanfrancisco.com → `s8I1GxleW7druAnvyOqP`

## Resubmit mechanism (when approved — DO NOT run until Amin says go)
`us_app_to_person` has no update endpoint. DELETE the existing SID (HTTP 204) then POST a new one under the same Messaging Service + Brand with the v2 message_flow. Each attempt is a fresh multi-day carrier-vetting cycle.
