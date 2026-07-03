# Exporting GHL consent into LI (defensible import)

Goal: get the **real, documented** SMS/email consent out of GHL and into LI so those
leads become textable in LI — with proof (timestamp + source) behind every opt-in,
and with anyone suppressed in GHL kept suppressed.

LI's bulk import (`Leads → Import`) already ingests per-row consent with provenance,
and (as of this branch) honors opt-out/DND as **dominant** — an opted-out lead can
never be messaged even if the same row carries an old opt-in.

---

## 1. What to export from GHL

Export a CSV of the contacts you want to work in LI, with these columns. The names
don't have to match exactly — you'll map them in LI's import UI — but the **content**
must be right.

| GHL column to export | Maps to LI field | Notes |
|---|---|---|
| First name | `first_name` | |
| Last name | `last_name` | |
| Email | `email` | |
| Phone | `phone` | E.164 preferred (+1…) |
| **SMS opt-in** (your real consent field) | `sms_consent` | `TRUE` only where the opt-in field is genuinely set; else `FALSE`/blank |
| **SMS opt-in date** | `sms_consent_at` | ISO date of the opt-in (proof) |
| Consent source / form name | `sms_consent_source` | e.g. `GHL: <vendor/form name>` (what they agreed to) |
| Email opt-in | `email_consent` | `TRUE`/`FALSE` |
| Email opt-in date | `email_consent_at` | |
| Email source | `email_consent_source` | |
| **GHL DND (do-not-contact)** | `do_not_contact` | `TRUE` for any contact with DND on — **suppresses all channels** |
| SMS-only DND (if you track it) | `sms_opt_out` | `TRUE` = never text |
| Email-only unsubscribe | `email_opt_out` | `TRUE` = never email |

### The three rules that keep this defensible
1. **Only `TRUE` where consent is real.** Mark `sms_consent = TRUE` only for contacts
   whose actual opt-in field is set. Do **not** blanket-true the file. (Leads without a
   real opt-in still import — they just arrive un-textable and go to email-first
   re-permission.)
2. **Always export DND.** Every contact on GHL DND must have `do_not_contact = TRUE`.
   This is the single most important column — it's what stops LI from texting someone
   who opted out. Opt-out wins over any opt-in on the same row.
3. **Keep the proof.** The opt-in date + source columns are your evidence if a consent
   is ever challenged. Don't drop them.

---

## 2. Import into LI

1. `Leads → Import`, upload the CSV.
2. Map each CSV column to the LI field in the table above.
3. In the attestation step, set **source** = `GHL consent export <date>` and **attested_at**
   = today. (Per-row dates override this; the wrapper is the fallback.)
4. Choose dedupe = **overwrite** if you want the consent/DND to update leads already in LI
   (recommended — it applies suppression to existing rows too), or **skip** to only add new.
5. Import. LI encrypts PII, sets `email_hash`/`phone_hash`, applies the opt-out precedence,
   and logs a HIPAA audit entry per lead.

After import: leads with a real opt-in are textable in LI; DND leads are suppressed on the
send-gates; everyone else is eligible for the email-first re-permission flow.

---

## 3. What this does NOT cover
- **SMS to leads without a documented opt-in.** Those stay un-textable; earn consent via
  re-permission (email-first) or leave to counsel.
- **Ongoing sync.** This is a point-in-time import. For continuous consent/DND sync, the
  GHL Private Integration Token must be re-issued with the custom-fields + contacts (DND)
  scopes (it currently lacks them — see `scripts/probe-ghl-consent.ts`), after which the
  native GHL sync can read consent automatically.
