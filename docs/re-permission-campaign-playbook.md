# Re-Permission Campaign Playbook — Dion Health SF

**Goal:** Convert the ~33k "old lead" pool (LI `sms_consent_status = 'unknown'`, mostly imported "progressive" lead-gen leads) into a genuinely **consented, first-party** SMS + email list — replacing the current 1,200-texts-every-6-hours GHL cold blast (4,800/day, ~5–10% opt-out).

> ⚠️ **Not legal advice.** This plan was adversarially reviewed by a TCPA/CTIA critic (verdict: **FAIL** on the SMS-to-unconsented premise) and a deliverability critic (verdict: **pass with fixes**). For 28k+ sends at $500–$1,500/message statutory exposure, get the SMS portion signed off by TCPA counsel before launch. This document bakes in every required fix from that review.

---

## The one decision that changes everything: segment by consent quality FIRST

You said your proof is a mix of **(1) "named us + authorized SMS"** and **(2) "records name the vendor"**, documented through **whatever GHL stored**. That means you cannot treat the 33k uniformly. **Step 0 is to pull the actual opt-in records from GHL and split the pool:**

| Tier | What the GHL record actually shows | Treatment |
|------|-----------------------------------|-----------|
| **A — Already consented** | Opt-in language that (a) explicitly authorizes **automated SMS/text marketing**, (b) **names Dion Health** (or a disclosed partner list that includes you), with (c) a **timestamp/source** | **Not a re-permission target.** Import the proof, set LI `sms_consent = true` / status `granted` with `sms_consent_source` + `sms_consent_at`, and message normally through the consent gate. |
| **B — Re-permission needed** | Vendor-named only, "general interest," SMS not specifically authorized, or no retrievable opt-in artifact | **Email-first re-permission** (below). SMS only after counsel sign-off + DNC scrub. |

**Reality check on "what GHL has":** for imported leads this is often just a contact record with a source tag and an `opt-in: true` flag — *not* the disclosure language + timestamp + IP that TCPA requires you to be able to produce. If GHL only has the flag, those leads are **Tier B**, not Tier A. Pull a sample and look at the actual artifact before classifying.

---

## Why email-first (the TCPA critic's core finding)

- A prior **web-form inquiry is not** prior express written consent for marketing texts. The Established Business Relationship (EBR) defense does **not** cure the written-consent requirement for autodialed marketing texts to wireless numbers.
- Therefore the **first SMS** to a Tier-B number is itself the exposure — re-permission framing doesn't change that.
- **Email re-permission** for prior inquirers is governed by CAN-SPAM (far lower risk), and a **hosted opt-in page with an affirmative checkbox** (capturing IP + timestamp + the exact disclosure shown) is a *far stronger* consent artifact than a one-word "Reply YES" to a text they never asked for.

So: **email is the primary channel** to convert Tier B. SMS re-permission is an optional, gated add-on.

---

## Pre-launch blockers (ALL must be true before the first send)

These are hard gates from the review, not nice-to-haves:

- [ ] **TCPA counsel sign-off** on the SMS portion (whether a single re-permission SMS to prior inquirers is defensible in your jurisdictions). Gating for any SMS to Tier B.
- [ ] **DNC scrub** — National DNC Registry + applicable state lists, with dated proof retained per number, before any phone contact.
- [ ] **Per-recipient local-time quiet hours (8am–9pm)** enforced in the GHL send scheduler. ⚠️ LI's `twilio.ts` gate uses the **org** timezone (`America/Los_Angeles`) — wrong for out-of-state leads; 8pm PT = 11pm ET = a per-message violation. Derive each lead's tz from state/ZIP (area code as fallback); default to the conservative cross-zone window (~11am–9pm ET) when tz is unknown. Add a pre-send assertion that **fails the batch** if any queued send falls outside 8am–9pm recipient-local.
- [ ] **STOP / HELP + bidirectional opt-out sync tested and LOGGED on prod** — reply STOP to a test phone → confirm auto-reply fires AND suppression writes to **both** GHL DND **and** LI `sms_opt_out = true` within seconds. Same for HELP. Confirm the **email track also suppresses** anyone who replied STOP to SMS. (Today LI shows `sms_opt_out = 0` — opt-outs live only in GHL DND; this sync is currently manual and unproven.)
- [ ] **Email auth** — SPF, DKIM, DMARC aligned and passing on the Resend sending domain. A 33k send to a dormant list with weak DMARC lands in spam regardless of copy.
- [ ] **Hosted opt-in page live** on the branded domain (`dionhealthsf.com/optin/<token>`) showing full TCPA disclosure (automated-marketing consent, message types, frequency cap "up to 4 msgs/month", "consent is not a condition of any purchase or treatment," Terms + Privacy links) with an **unchecked** affirmative checkbox capturing IP + timestamp + exact text. This — not "Reply YES" — is the consent record.
- [ ] **GHL A2P use-case** confirmed to cover the content you'll send (no "offers"/promotional language pre-consent).

---

## Channel 1 — Email re-permission (PRIMARY, for Tier B)

One click on the hosted opt-in CTA confirms **both** SMS + email. Two variants for A/B.

**Variant A — Personal note from the care team**
- **Subject:** `{{first_name}}, can we keep you in the loop?`
- **Preheader:** A quick yes lets our team text and email you about your implant options — no obligation.
- **Body:**
  > Hi {{first_name}},
  >
  > A little while back you reached out to **Dion Health San Francisco** about dental implants. We never want to be a nuisance, so before we send anything else, we'd like your okay.
  >
  > If you'd still like updates from our care team — appointment availability, financing options, and answers to the questions most patients ask before treatment — just tap the button below to confirm. You'll choose to hear from us by **text and email**, and you can change your mind anytime.
  >
  > [**Yes, keep me updated →**]({{optin_url}})
  >
  > No pressure either way. If now isn't the right time, you don't need to do anything — we won't keep emailing you about this.
  >
  > Warmly,
  > The Care Team at Dion Health San Francisco
  >
  > ---
  > *By confirming, you agree to receive automated marketing texts and emails from Dion Health (Samadian Cosmetic & Advanced Dentistry). Message frequency varies (up to ~4 msgs/month); message & data rates may apply. Reply STOP to any text to opt out, or HELP for help. Consent is not a condition of any purchase or treatment.*
  > *Dion Health San Francisco · {{org_address}}*
  > *You're receiving this because you previously inquired with us. Prefer no more emails? [Unsubscribe here]({{unsubscribe_url}}).*

**Variant B — Direct, one-click confirm**
- **Subject:** `Still considering dental implants, {{first_name}}?`
- **Preheader:** Confirm your contact preferences and we'll keep your implant info coming — text or email, your call.
- **Body:**
  > Hi {{first_name}},
  >
  > You once asked us about dental implants at **Dion Health San Francisco**, and we'd love to pick up where we left off — but only if you want us to.
  >
  > Confirm below and our team will keep you posted on **implant options, current financing, and open appointment times**, by text and email:
  >
  > [**Yes — you can contact me →**]({{optin_url}})
  >
  > That's it. One tap opts you in for both, and every message includes an easy way out whenever you'd like.
  >
  > Talk soon,
  > Dion Health San Francisco · Samadian Cosmetic & Advanced Dentistry
  >
  > ---
  > *By confirming, you agree to receive automated marketing texts and emails from Dion Health (Samadian Cosmetic & Advanced Dentistry). Message frequency varies (up to ~4 msgs/month); message & data rates may apply. Reply STOP to any text to **opt out**, or HELP for help. Consent is not a condition of any purchase or treatment.*
  > *Dion Health San Francisco · {{org_address}}*
  > *You received this email because you submitted an inquiry with us. Prefer no more emails? [Unsubscribe here]({{unsubscribe_url}}).*

**Email send discipline:** text-only (no images), one CTA, physical address + one-click unsubscribe in footer (RFC 8058 List-Unsubscribe headers already in `src/lib/messaging/email-footer.ts`). **Warm the volume** — this list hasn't been emailed recently; ramp ~2–3k/day rising, don't spike all 28k in one day. Suppress anyone who unsubscribed or replied STOP via SMS before each batch.

---

## Channel 2 — SMS re-permission (OPTIONAL, Tier B, ONLY after counsel sign-off + DNC scrub)

If counsel clears it, send **ONE** SMS touch per number (the review explicitly rejected a 2nd unconsented touch — silence is not consent). Drop the "Soft Offer" variant entirely (promotional language pre-consent).

**Lead variant — Simple Direct (1 segment, full disclosure quartet):**
> `Dion Health SF: you asked us about dental implants. OK to text you? Reply YES to opt in (up to 4 msgs/mo). Msg&data rates apply. Reply STOP to opt out, HELP for help.`

**Optional A/B — Warm Relationship** (warmer tone; runs ~2 segments with full disclosures, so test cost/lift vs. the 1-segment lead):
> `Hi {{first_name}}, this is Dion Health SF. You previously inquired about dental implants. OK to text you occasional updates? Reply YES (up to 4 msgs/mo). Msg&data rates apply. Reply STOP to opt out, HELP for help.`

**Confirmation (on YES):**
> `Dion Health SF: You're confirmed, {{first_name}} — thank you! We'll text up to 4 helpful updates/month about dental implants. Reply STOP anytime to opt out, HELP for help. Msg&data rates may apply.`

**HELP reply:**
> `Dion Health SF (Samadian Cosmetic & Advanced Dentistry). For help call <support#>. Up to 4 msgs/mo. Reply STOP to opt out. Msg&data rates may apply.`

Every pre-consent SMS must carry: full brand identity + explicit YES ask + concrete frequency cap + "Msg&data rates apply" + "Reply STOP / HELP." Treat the **hosted opt-in page checkbox** as the consent record, not the YES reply.

---

## Throttled cadence (SMS, if it runs)

Sending via the **GHL LeadConnector A2P number** (LI's own US 10DLC is FAILED/pending — do **not** route US SMS through LI's blocked Twilio path).

**Segmentation — include:** Tier-B leads where `sms_consent_status='unknown'` AND `sms_opt_out` not true AND `do_not_call` not true AND valid **US mobile** (E.164, carrier line-type = wireless; exclude landline/VOIP, ~6–8% loss) AND prior-inquiry relationship (`external_ref` set). This is `isEligibleForConsentCapture(lead,'sms')` + a mobile check.
**Exclude:** the 1,027 `declined`; LI `sms_opt_out`/`do_not_call`; **fresh GHL DND** (re-pull and left-anti-join on normalized E.164 before *every* batch); no/invalid phone; duplicate E.164; non-+1; anyone with an in-flight conversation or token issued in last 30 days. **Estimated deliverable ≈ 28,500.**

**Warmup ramp** (require **2 consecutive healthy days** before the first jump; first **250 lifetime sends = the 1-segment lead variant only** to set a clean content fingerprint):

| Phase | Volume/day | Gate to advance |
|-------|-----------|-----------------|
| Day 1 | 50 | midday single batch; 24h observe |
| Day 2 | 100 | delivery ≥92%, opt-out ≤1%, zero filtering |
| Day 3 | 200 | split AM/PM, <1 msg/sec |
| Day 4 | 350 | sub-linear; confirm replies, not just deliveries |
| Day 5 | 500 | hold & observe; verify STOP/HELP + DND writeback |
| Day 6 | 750 | opt-out still low, filtering <1% |
| Day 7+ | **1,000 (steady cap)** | hold while kill-criteria green |

**Steady state:** 1,000/day (~1/5 of the old blast), 5 send-days/week (Tue–Sat skew), 2–3 small sub-batches inside local-time windows, explicit per-second throttle (well under 1 msg/sec, jittered).
**Send windows:** 8am–9pm **recipient-local** (hard). Sweet spots 10am–1pm / 4–7pm. Tue–Thu strongest; avoid Sun and Mon-before-10am; never on US holidays. Run as a rolling local-time scheduler (East fires first).
**Attempts:** **ONE** SMS touch per number. Non-responders → email track only. Never a 2nd unconsented text.
**Throughput:** ~28,500 ÷ ramp+1,000/day ≈ 33 send-days ≈ ~6–7 calendar weeks at 5 days/week for the single SMS touch.

**Kill criteria (tightened per TCPA review):**
- STOP rate **≥1%** on a batch → **pause** same day, review copy/targeting.
- STOP rate **≥3%** → **hard stop** the SMS program; move remainder to email.
- Cumulative STOP **≥2–3%** of all sent → stop SMS, reassess.
- Any carrier filtering event (map to GHL's delivery-status/error surface, not Twilio 300xx) or any spam-complaint report → immediate pause-and-review.
- Delivery **<90%** on a batch → pause (treat as silent filtering).
- STOP auto-reply or DND writeback observed NOT firing → immediate hard stop.
- GHL flags/suspends the number → hard stop; **do not** migrate to a new number to evade.

---

## Success metrics

- **Net consented-list growth** (`unknown → granted`) — the real business outcome.
- Opt-in rate ≥5–8% of deliverable pool (primary).
- SMS delivery ≥95%; STOP ≤1% per batch (vs. legacy 5–10%).
- Carrier filtering <1%.
- Cost per opt-in: email track vs. SMS track → decide channel mix.

---

## What this requires building in LI (next step — "close the loop")

When a lead opts in (YES reply or hosted-page checkbox), it must flow **back into LI** as real consent so the consent gate flips them to `granted` and the AI auto-responder / pipeline can work them:
- Opt-in event → LI `sms_consent=true`, `sms_consent_status='granted'`, `sms_consent_at`, `sms_consent_source`, plus the stored disclosure/IP/timestamp artifact.
- **Bidirectional opt-out sync:** GHL DND ↔ LI `sms_opt_out` (and email unsubscribe), so a decline on either channel suppresses both — closing the gap that currently leaves LI's `sms_opt_out = 0`.
