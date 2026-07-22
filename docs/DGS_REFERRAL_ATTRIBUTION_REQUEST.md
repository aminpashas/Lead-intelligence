# DGS → LI: doctor-referral attribution + custom-field forwarding

**Owner:** Dion Growth Studio (`dion-growth-studio`) resolver + `/api/v1/leads` push
**Consumer:** Lead Intelligence `POST /api/v1/leads`
**Status:** requested 2026-07-21 · LI receiving side already shipped (see below)

## Why

A referring dentist submitted a TMJ patient through the practice's
`/referring-doctors/` web form → GHL → DGS → LI. In LI the lead (`ximalatl
avalos`, SF org) showed up as a **blank "Direct" record** — 0/100 identity
confidence, no condition, no referring doctor — even though GHL held all of it.
Two DGS-side gaps caused this:

### (a) Channel mis-resolved as `direct`
DGS keyed the resolution on `utm_medium = "Direct traffic"` and, with no
click-id, stamped:

```json
{ "channel": "direct", "attribution_confidence": 0.3, "source_system": "dion_growth_studio" }
```

It ignored the actual referral signals that were present:
`utm_source = doctor_referral`, `utm_campaign = doctor_referral_form`, and
`landing_page = …/referring-doctors/`.

**Ask:** when `utm_source`/`utm_campaign` contains a `referr*` token (or the
landing path is a referring-doctor form), resolve `channel: "referral"`, not
`direct`. Confidence can stay modest — the point is the *bucket*.

> LI mitigation already shipped (commit on `main`): `reconcileChannel` now
> overrides a **low-confidence (≤ 0.4) `direct`** from DGS when the flat utm
> signals name something more specific, stamping `source_system:
> "li_utm_override"`. This is a safety net — the durable fix is DGS resolving it
> right the first time, because a *confident* DGS channel is (by design) never
> overridden by LI.

### (b) GHL custom fields not forwarded
The bridge payload carried only name/phone/email + `Message: "new referral"` +
UTMs. The rich GHL contact custom fields — **referring doctor, referring
practice + contact, referral reason, clinical note, DOB** — were dropped, so LI
had nothing to show or score on.

**Ask:** map the GHL contact custom fields onto the `custom_fields` object in the
`/api/v1/leads` body. LI **already accepts and persists** these (allow-listed):

| `custom_fields` key          | Example value                                             |
|------------------------------|----------------------------------------------------------|
| `referring_doctor`           | `Dr. Manali Rathod`                                       |
| `referring_practice`         | `The Dental Practice \| SF`                               |
| `referring_practice_phone`   | `+14153974433`                                            |
| `referring_practice_email`   | `info@thedentalpracticesf.com`                            |
| `referral_reason`            | `TMJ`                                                     |
| `referral_priority`          | `Medium`                                                  |
| `referral_clinical_note`     | `Pt. has increased popping upon opening…`                |
| `treatment_interest`         | (LI derives this itself; sending it is optional)          |

Values are strings (string arrays are joined). Unknown keys are dropped by LI's
allow-list — extend `src/lib/leads/custom-fields.ts:CUSTOM_FIELD_KEYS` on the LI
side before adding a new one.

DOB, if available, should be sent as the top-level `date_of_birth` field
(`YYYY-MM-DD`) — it feeds LI's voice identity-verification gate. (Confirm LI
accepts a top-level `date_of_birth`; if not, that's a small LI add.)

## LI receiving side — already done (`main`)

- `custom_fields` is read, allow-list-sanitized, and persisted on insert.
- A dedup re-POST (same `external_ref`) **back-fills** any custom fields the lead
  is missing — so DGS can send name/phone first and re-sync the referral detail
  once its resolver runs, without creating a duplicate.
- `reconcileChannel` corrects a weak DGS `direct` as described in (a).

## Acceptance criteria

1. A `/referring-doctors/` form lead arrives at LI with `campaign_attribution.channel = "referral"`.
2. `custom_fields.referring_doctor` / `referring_practice` / `referral_reason` /
   `referral_clinical_note` are populated on the LI lead.
3. A re-POST of an already-known referral lead enriches it (no duplicate, no
   clobbering of values a human already edited).
