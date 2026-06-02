# SMS Compliance Work Order — Final (for Wasif)

**Goal:** Make our patient text-messaging carrier-compliant so it gets approved (our first submission was rejected for two reasons: a non-compliant opt-in checkbox and a privacy policy missing the required mobile-data clause).

**Reviewers visit the live pages**, so everything must be published and publicly accessible (not behind a login). Below is exactly what to add, where, with the exact text/code to use.

---

## The three sites + where things go

| Site | Privacy policy | Terms / Messaging Terms | Contact form |
|---|---|---|---|
| **dionhealth.com** | Edit existing `/privacy-policy/` | **Append** SMS terms to existing `/terms-and-conditions/` | `/contact/` |
| **sfdentistry.com** | Edit existing `/privacy-policy/` | **Create** new `/sms-terms/` page | `/contact/` |
| **tmjandsleepapneasanfrancisco.com** | Edit existing `/privacy-policy/` **and link it in the footer** (currently not linked) | **Create** new `/sms-terms/` page | `/contact/` |

> **Important — do not create duplicate pages.** All three privacy policies and Dion's terms page already exist. Edit them in place. Only sfdentistry and TMJ need a brand-new Messaging Terms page.

---

## ASSET 1 — SMS consent checkbox (add to every form that collects a phone number)

Requirements (all mandatory — these are exactly what got rejected before):
- **Unchecked by default.**
- **Separate** from the "I agree to terms/privacy" box — do not bundle.
- Form must **still submit if left unchecked** (consent is optional).
- Maps to a **custom contact field** in GHL so the opt-in is recorded per lead (who/when/which page).

### Drop-in HTML (swap the business name per site)

```html
<label style="display:flex; align-items:flex-start; gap:8px; font-size:14px; line-height:1.4;">
  <input type="checkbox" name="sms_consent" value="yes" />
  <span>
    By checking this box, I agree to receive text messages from
    <strong>Dion Health</strong> about appointment scheduling, reminders, and
    treatment follow-ups at the mobile number provided. Message frequency varies.
    Message and data rates may apply. Reply STOP to opt out or HELP for help.
    See our <a href="/sms-terms/" target="_blank">Messaging Terms</a> and
    <a href="/privacy-policy/" target="_blank">Privacy Policy</a>.
  </span>
</label>
```

**Business name to display per site** (all texts send from one registered sender, "Dion Health" — name it so patients know who's texting):
- dionhealth.com → `Dion Health`
- tmjandsleepapneasanfrancisco.com → `Dion Health (TMJ & Sleep)`
- sfdentistry.com → `Dion Health (Samadian Cosmetic & Advanced Dentistry)`

**Link targets per site:**
- dionhealth.com → Messaging Terms link points to `/terms-and-conditions/` (the appended section); Privacy `/privacy-policy/`
- sfdentistry.com & TMJ → Messaging Terms link points to `/sms-terms/`; Privacy `/privacy-policy/`

**GHL note:** create a custom contact field (e.g. `sms_consent`, type checkbox/text) and map this checkbox to it so the value is stored on the contact record on submission.

---

## ASSET 2 — Privacy Policy "SMS / Text Messaging" section (add to all 3 privacy policies)

This is the part that caused the carrier rejection (error 30882). The **bold sentence is required verbatim** — do not reword it.

> ### SMS / Text Messaging
>
> When you provide your mobile number and opt in, we may send you text messages about appointment scheduling, reminders, treatment follow-ups, and related care coordination from Dion Health.
>
> **Mobile information and SMS opt-in data are never shared with, sold to, or rented to any third parties or affiliates for marketing or promotional purposes.** No mobile information is shared with third parties except subcontractors strictly necessary to deliver the messages (e.g., our SMS provider), and those parties are prohibited from using it for any other purpose.
>
> Message frequency varies. Message and data rates may apply. Reply **STOP** at any time to unsubscribe, or **HELP** for assistance. Standard carrier rates apply.

On **tmjandsleepapneasanfrancisco.com**, after editing the policy, also **add a Privacy Policy link to the site footer** — it currently isn't linked anywhere, and the carrier must be able to reach it.

---

## ASSET 3 — Messaging Terms page content

Create this as a new `/sms-terms/` page on **sfdentistry.com** and **tmjandsleepapneasanfrancisco.com**. On **dionhealth.com**, append this same content as a section to the existing `/terms-and-conditions/` page.

> # Messaging Terms & Conditions
>
> **Program description.** Dion Health sends text messages about appointment scheduling, reminders, treatment follow-ups, and related patient care coordination to individuals who have opted in by providing their mobile number and agreeing to receive messages.
>
> **Opt-in.** You opt in by checking the SMS consent box on our contact or appointment-request form and submitting your mobile number. Consent is not a condition of purchase or of receiving any service.
>
> **Message frequency.** Message frequency varies based on your interactions with us.
>
> **Cost.** Message and data rates may apply, per your mobile carrier plan.
>
> **Opt-out.** Reply **STOP** at any time to unsubscribe. You will receive a confirmation and no further messages.
>
> **Help.** Reply **HELP** for assistance, or contact us at the phone number listed on this website.
>
> **Carriers.** Carriers are not liable for delayed or undelivered messages.
>
> **Privacy.** Mobile information and SMS opt-in data are never shared with, sold to, or rented to any third parties or affiliates for marketing or promotional purposes. See our Privacy Policy for details.

---

## Final checklist (per site)

**dionhealth.com**
- [ ] SMS consent checkbox added to all phone-number forms (name: "Dion Health"), mapped to GHL custom field
- [ ] SMS section added to `/privacy-policy/`
- [ ] Messaging Terms section appended to existing `/terms-and-conditions/`

**sfdentistry.com**
- [ ] SMS consent checkbox added to all phone-number forms (name: "Dion Health (Samadian Cosmetic & Advanced Dentistry)"), mapped to GHL custom field
- [ ] SMS section added to `/privacy-policy/`
- [ ] New `/sms-terms/` page created (Asset 3)

**tmjandsleepapneasanfrancisco.com**
- [ ] SMS consent checkbox added to all phone-number forms (name: "Dion Health (TMJ & Sleep)"), mapped to GHL custom field
- [ ] SMS section added to `/privacy-policy/`
- [ ] Privacy Policy link **added to footer** (currently orphaned)
- [ ] New `/sms-terms/` page created (Asset 3)

**All sites**
- [ ] Checkbox is unchecked by default, separate from terms box, optional to submit
- [ ] All linked pages (`/privacy-policy/`, `/sms-terms/` or `/terms-and-conditions/`) are live and publicly accessible (no login)

---

## When done

Send Amin the live URLs for each site's **contact form** and **privacy policy** (and the new `/sms-terms/` pages). He'll submit them to the carrier. Once approved, messaging works automatically — no further website changes.
