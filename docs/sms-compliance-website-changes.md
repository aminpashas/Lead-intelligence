# SMS Compliance — Website Changes Needed (for Wasif)

**Goal:** Get our text-messaging (Twilio A2P 10DLC) campaign approved so appointment reminders and patient follow-ups actually deliver to US phones. Carriers **rejected** our first submission for two reasons, both fixable on the websites:

1. **Opt-in flow not compliant** — our web forms need a separate, *unchecked* SMS consent checkbox with the required disclosures.
2. **Privacy policy not compliant** — it must explicitly state we never share/sell mobile numbers to third parties.

Apply the changes below to **all three sites**:
- **Dion Health** (dionhealth.com)
- **TMJ & Sleep** site ( _<fill in domain>_ )
- **SF Dentistry** (sfdentistry.com)

These reviewers literally visit the pages, so everything must be **live and publicly accessible** (not behind a login).

---

## Change 1 — Add an SMS consent checkbox to every lead/contact form

On each site's contact form, appointment-request form, and any landing-page lead form, add a **separate checkbox**. Requirements (all mandatory):

- The checkbox must be **unchecked by default**.
- It must be **separate** from the Terms / Privacy acceptance — do **not** bundle "I agree to texts" into a general "I agree to terms" box.
- The user must be able to **submit the form without checking it** (consent is optional).
- The text must include: what messages we send, "message frequency varies," "message and data rates may apply," STOP/HELP instructions, and links to Terms + Privacy.

### Drop-in HTML (adjust the business name per site)

```html
<label style="display:flex; align-items:flex-start; gap:8px; font-size:14px; line-height:1.4;">
  <input type="checkbox" name="sms_consent" value="yes" />
  <span>
    By checking this box, I agree to receive text messages from
    <strong>Dion Health</strong> about appointment scheduling, reminders, and
    treatment follow-ups at the mobile number provided. Message frequency varies.
    Message and data rates may apply. Reply STOP to opt out or HELP for help.
    See our <a href="/sms-terms" target="_blank">Messaging Terms</a> and
    <a href="/privacy-policy" target="_blank">Privacy Policy</a>.
  </span>
</label>
```

**Per-site business name to show in the checkbox:**
- Dion Health site → `Dion Health`
- TMJ & Sleep site → `Dion Health (TMJ & Sleep)` — name the actual sender so it's clear who texts them
- sfdentistry.com → `Dion Health (Samadian Cosmetic & Advanced Dentistry)`

> **Why name "Dion Health" on every site:** all texts go out from one registered sender (Dion Health). Whoever signs up on any site must be told *that's* who will text them, or carriers flag a mismatch.

**Send the `sms_consent` value through to wherever the lead is stored** so we have a record of who opted in (timestamp + which page).

---

## Change 2 — Add this SMS section to every Privacy Policy

This is the part that got us rejected (carrier error 30882). The exact missing piece is the **no-sharing clause**. Paste this section into the privacy policy on all three sites:

> ### SMS / Text Messaging
>
> When you provide your mobile number and opt in, we may send you text messages
> about appointment scheduling, reminders, treatment follow-ups, and related care
> coordination from Dion Health.
>
> **Mobile information and SMS opt-in data are never shared with, sold to, or
> rented to any third parties or affiliates for marketing or promotional
> purposes.** No mobile information is shared with third parties except
> subcontractors strictly necessary to deliver the messages (e.g., our SMS
> provider), and those parties are prohibited from using it for any other purpose.
>
> Message frequency varies. Message and data rates may apply. Reply **STOP** at any
> time to unsubscribe, or **HELP** for assistance. Standard carrier rates apply.

The sentence in **bold** is the one carriers specifically look for — please don't reword it away.

---

## Change 3 — Make sure there's a Terms (or Messaging Terms) page

Each site needs a publicly reachable page the checkbox can link to. A short **Messaging Terms** page is fine and can contain the same disclosures (program description, frequency, rates, STOP/HELP, link to privacy policy). The links in the checkbox (`/sms-terms`, `/privacy-policy`) must resolve to real, public pages.

---

## Checklist (per site)

- [ ] Consent checkbox added to **every** form that collects a phone number
- [ ] Checkbox is **unchecked by default** and **optional** (form submits without it)
- [ ] Checkbox is **separate** from Terms/Privacy acceptance
- [ ] Checkbox text names **Dion Health** and includes frequency + "rates may apply" + STOP/HELP + links
- [ ] Privacy policy includes the **SMS section** with the bold no-sharing sentence
- [ ] `/privacy-policy` and `/sms-terms` (or your equivalents) are **live and public**
- [ ] Pages are **not** behind a login or password

---

## When the pages are live

Send me (Amin) the live URLs of the **contact form** and **privacy policy** for each site. I'll update our Twilio campaign submission to point at them and resubmit for approval. Once approved, texting works automatically — no further changes on your end.

_Questions on any of this can come to me; I have the full carrier rejection details._
