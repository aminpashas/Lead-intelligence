# Dion Health — Full Mouth Reconstruction (FMR) Agreement, Consents & Instructions

**Consolidated Master — v9 (2026)**
Effective date: `{{effective_date}}` · Document version: `{{contract.version}}`
Supersedes: "FMR Contract Master Copy — version 7_2025" and corrected v8.

> Source of truth for the digital, e-signable FMR packet in the Lead Intelligence app.
> Dynamic values are `{{merge.fields}}`, resolved per patient at generation time
> (see Variable Legend). Text marked **[LEGAL REVIEW]** is binding legal language that
> must be confirmed by licensed counsel before go-live — it was reorganized and
> de-duplicated but not substantively rewritten. Clinical facts, risk figures, and
> medication guidance are carried over from v7 unchanged.

---

## What changed in v9 (consolidation & additions)

**Redundancies merged**

| Repeated topic (v7 locations) | Now lives in |
|---|---|
| Oral hygiene / maintenance duties (Terms, Alternatives, Implant consent, Post-op) | §A3 Warranty, Maintenance & Patient Responsibilities |
| Smoking liability (Terms, Smoker consent, Implant consent) | §A3 (warranty-void trigger) + §B3 (clinical acknowledgment) |
| Driving / escort restrictions (Sedation consent, Pre-op, Post-op) | §D1 Pre-Op + §D2 Post-Op (stated once each) |
| "Consequences of a fixed prosthesis" (Alternatives + Implant consent) | §B1 Informed Consent for Implant Surgery |
| General Post-Op + Implant Post-Op (two overlapping sheets) | §D2 Post-Operative Instructions (single sheet) |
| Alternatives (Options 1–3) + Facts + Risks + Patient Criteria (4 sections) | §B1 Informed Consent for Implant Surgery (one section) |

**Sections added (were missing in v7)**

- §A2 — **Refund & Cancellation Policy** (uses `{{legal.cancellation_policy_days}}` / `{{legal.refund_policy_days}}`), insurance / assignment-of-benefits note.
- §A4 — **General Provisions**: governing law, entire agreement, amendment, severability, assignment, notices (arbitration consolidated here). **[LEGAL REVIEW]**
- §C1 — **HIPAA Notice of Privacy Practices Acknowledgment**.
- §C2 — **Medical History & Medication Disclosure Attestation** (+ authorization to contact your other providers, moved out of Terms).
- Front matter — **Electronic Records & Signatures Consent (ESIGN/UETA)** and **Voluntary Consent & Right to Ask Questions**.
- Closing — **Acknowledgment & Receipt of Copy**.

**Corrections retained from v8**

Progressive Dental → Dion Health; "m real teeth" → "my natural teeth"; "initializing" →
"initialing"; "gi closure" → "tissue (gingival) closure"; financial page completed;
CT-scan two-signature trap → single election; every section self-identifies with patient
name + DOB.

---

## Variable Legend

| Merge field | Source |
|---|---|
| `{{patient.full_name}}`, `{{patient.dob}}` | case / intake |
| `{{doctor.name}}` | case / provider |
| `{{coordinator.name}}`, `{{coordinator.phone}}`, `{{coordinator.email}}` | org / case |
| `{{treatment.description}}` | treatment plan |
| `{{surgery.location}}`, `{{postop.location}}`, `{{surgery.date}}`, `{{preop.date}}` | booking |
| `{{financial.total_before_discount}}`, `{{financial.discount_amount}}`, `{{financial.total_to_patient}}`, `{{financial.deposit_amount}}` | closing |
| `{{financial.balance_due}}`, `{{financial.payment_method}}` | closing |
| `{{legal.entity_name}}`, `{{legal.governing_law}}`, `{{legal.arbitration_venue}}` | org legal settings |
| `{{legal.cancellation_policy_days}}`, `{{legal.refund_policy_days}}` | org legal settings |
| `{{practice.emergency_phone}}` | org |
| `{{org.name}}`, `{{effective_date}}`, `{{contract.version}}` | org / system |
| `{{intake.preferred_pharmacy}}`, `{{intake.pcp_name}}`, `{{intake.driver_name}}`, `{{intake.emergency_contact}}` | booking / EHR intake |

---

# Before You Sign

## Voluntary Consent & Right to Ask Questions

Your care and these agreements are entered into voluntarily. You have the right to ask
your doctor or treatment coordinator any question before signing, to request more time,
to seek a second opinion, and to decline or discontinue elective treatment. If you need
an interpreter or an accessible format, tell us and we will arrange it at no cost. By
continuing, you confirm you have had the opportunity to ask questions and that your
questions have been answered to your satisfaction.

## Electronic Records & Signatures Consent (ESIGN / UETA)

You agree to receive and sign these records electronically. Your electronic signature
has the same legal effect as a handwritten one. You may request a paper copy at any time
and may withdraw consent to electronic records before signing by contacting your
treatment coordinator; withdrawing consent may delay treatment. To sign electronically
you need a device with a modern web browser and an email address or mobile number where
we can reach you. Disclosure version: recorded with your signature.

☐ I have read and agree — **Electronic Records & Signatures Consent.**

> **Consent key:** `esign_consent` · records `esign_disclosure_version`.

---

# PART A — Agreement & Financial Terms

## §A1. Parties & Treatment Plan

This agreement is between **`{{legal.entity_name}}`** ("Dion Health," "we," "us") and the
patient identified below ("you").

Thank you for trusting Dion Health with your oral health care. During the course of your
treatment you will work with a team of highly skilled doctors and providers. The initial
treatment plan below has been diagnosed and agreed upon. It is subject to change based on
clinical findings during treatment; any changes will be discussed with you at the time of
findings, and any change in cost will be presented for approval before proceeding.

- **Patient:** `{{patient.full_name}}` · **DOB:** `{{patient.dob}}`
- **Treatment:** `{{treatment.description}}`
- **Surgery location:** `{{surgery.location}}` · **Post-operative care:** `{{postop.location}}`
- **Treating doctor:** `{{doctor.name}}`
- **Treatment coordinator:** `{{coordinator.name}}` — `{{coordinator.phone}}` · `{{coordinator.email}}`

## §A2. Financial Agreement

| | |
|---|---|
| Total cost of treatment | `{{financial.total_before_discount}}` |
| Discount (paid-in-full for total treatment) | −`{{financial.discount_amount}}` |
| **Total cost to patient** | **`{{financial.total_to_patient}}`** |
| Non-refundable deposit (design, planning, surgical guides, facility fee, and other included costs) | `{{financial.deposit_amount}}` |
| Balance due before treatment | `{{financial.balance_due}}` |

- **Pre-Op appointment:** `{{preop.date}}` · **Date of surgery:** `{{surgery.date}}`
- **Payment:** The initial deposit and agreed total must be paid **no later than 2 weeks prior** to the scheduled surgery. If payment is not received, the appointment may be cancelled and only rescheduled once the financial obligation has been met.
- **Late balances:** Any balance **30 days past due** from the dates agreed above is subject to **5% interest**.
- **Price-Match:** Dion Health will price-match a comparable, documented written treatment estimate for the same scope of care from a licensed provider, at Dion Health's discretion. Ask your treatment coordinator for details. *(Confirm final policy wording.)*

**Refund & Cancellation Policy** *(new — was undefined in v7)*

- The **deposit is non-refundable** once design, planning, or surgical guides have begun, as it covers work performed and materials ordered on your behalf.
- Cancellations, no-shows, or rescheduling of surgery **within 48 hours** may be subject to an additional fee.
- You may cancel elective treatment not yet begun within **`{{legal.cancellation_policy_days}}` days** of signing; refunds of amounts paid beyond the non-refundable deposit are processed within **`{{legal.refund_policy_days}}` days**. **[LEGAL REVIEW]**

**Insurance & Assignment of Benefits.** Fees quoted are your responsibility regardless of
insurance. If you have coverage, we can, at your request, submit claims and accept
assignment of benefits; any insurance payment is credited to your balance. You remain
responsible for amounts insurance does not pay. *(Include only if the practice bills
insurance.)* **[LEGAL REVIEW]**

**I HAVE READ, UNDERSTAND, AND AGREE TO THE FINANCIAL ARRANGEMENTS ABOVE.**

Patient: `{{patient.full_name}}` · DOB: `{{patient.dob}}` · Signature: ⟦e-signature⟧ · Date: ⟦auto⟧
Provider (optional): `{{doctor.name}}` — Signature: __________ · Date: ______

> **Consent key:** `financial_agreement`

## §A3. Warranty, Maintenance & Patient Responsibilities

*(Consolidates the v7 Terms & Conditions, plus the maintenance and liability language
that was repeated in the Alternatives and Implant-consent sections.)*

**What our support covers.** It may be necessary for the doctor to perform remakes during
the first six months following the procedure; this is normal and included so long as you
follow all treatment instructions. If clinical issues arise, a new prosthesis may be
remade with your consent. Once aesthetics are finalized, a prosthesis will not be remade
due to a change of mind. Crowns and veneers may chip during the six-month adjustment
period; such chips are a normal part of the process. If you chip or break a portion of the
prosthetics within **12 months** after treatment, a replacement may be provided **for a
fee**.

**What our support does not cover.** One-year maintenance does **not** include free repair
or replacement for: prosthesis loss, discoloration, excessive wear, inappropriate use (any
use not prescribed by the prosthodontist), or neglect or abuse of the prosthesis. Any
adjustment or alteration of the prosthesis by someone other than an authorized
representative of our choosing **automatically voids** our support obligation. If you want
treatment redone after successful clinical delivery, or want to change the agreed plan,
full price applies.

**Your maintenance duties.** You are required to: maintain a high level of oral hygiene;
have **up to four professional cleanings each year**; wear an **occlusal night guard every
night**; and keep implants and prosthesis clean through daily care and regular checkups.
You may still need other treatment in the future (periodontal, orthodontic, restorative),
which is your responsibility and not included in this plan.

**Conditions and habits that void the warranty and shift responsibility to you.** Treatment
failure caused by grinding/clenching (bruxism), malocclusion, untreated sleep apnea, or by
a medical condition (e.g., uncontrolled diabetes, auto-immune disease) or a habit that
complicates healing — **including smoking, vaping, and marijuana use** (see §B3) — is your
responsibility; Dion Health is not obligated to reimburse or redo the treatment.

**No guarantee of biological outcomes.** There is **no guarantee** on osseointegration of
implants or integration of bone grafts; these depend on your immune system, medical
condition, and hygiene and are outside our control. Additional bone grafting or implant
work — including removing and replacing implants — may be necessary; any resulting change
in plan and cost will be discussed with you before proceeding.

**Outside providers.** Treatment from an unaffiliated provider outside the Dion Health
network automatically removes Dion Health from any obligation to support your treatment,
unless we specifically referred you to that outside specialist.

Patient: `{{patient.full_name}}` · DOB: `{{patient.dob}}` · Signature: ⟦e-signature⟧ · Date: ⟦auto⟧

> **Consent key:** `warranty_and_responsibilities`

## §A4. General Provisions **[LEGAL REVIEW]**

**Arbitration of Disputes.** Any dispute between you and the doctor/office will be
arbitrated and fully resolved by a local arbitrator licensed, qualified, and experienced
in prosthesis treatments of the nature performed on you. Either party may give written
notice requesting to meet and resolve the dispute; the parties will seek to resolve it
reasonably within thirty (30) days. If unresolved, either party may give notice of
arbitration, to be conducted in the county where the procedure was performed
(`{{legal.arbitration_venue}}`). The parties shall appoint a mutually agreed arbitrator
with at least five (5) years' experience deciding disputes of this nature; if they cannot
agree within thirty (30) days, either party may apply to the local office of the American
Arbitration Association (or another qualified professional association, "AAA") for
appointment. The arbitrator decides under AAA rules and enters a binding award; a party
that must compel arbitration, or that unsuccessfully challenges or fails to comply with the
award, is liable for the other party's costs of suit including reasonable attorneys',
expert-witness, and enforcement fees. Enforcement may be carried out in the local Superior
Court.

**Governing Law.** This agreement is governed by the laws of `{{legal.governing_law}}`.

**Entire Agreement.** This document (all parts) is the entire agreement between you and
Dion Health regarding this treatment and supersedes prior discussions or estimates.

**Amendments.** Changes to the treatment plan or cost are effective only when documented
and agreed by both parties (electronically or in writing).

**Severability.** If any provision is held unenforceable, the remaining provisions stay in
effect.

**Assignment.** You may not assign this agreement. Dion Health may assign it to a successor
practice on notice to you.

**Notices.** Notices to you are sent to the email, phone, or address on file; notices to
Dion Health go to your treatment coordinator.

☐ I have read and agree — **General Provisions, including binding arbitration.**

> **Consent key:** `general_provisions` · **[LEGAL REVIEW]** — binding arbitration in
> healthcare agreements has state-specific format/disclosure rules.

---

# PART B — Informed Consents

## §B1. Informed Consent for Implant Surgery

*(Consolidates v7 "Alternative Treatment Plans," "Informed Consent Discussion for Implant
Placement," "Facts for Consideration," "Risks/Benefits/Alternatives," and "Patient
Criteria" — with the duplicated fixed-prosthesis language stated once.)*

**Alternatives to implant treatment.** You may choose:

- **No replacement of missing teeth** — possible drift of adjacent/opposing teeth, collapse of arch integrity, and worsening of present complaints; later repair may become more difficult, costlier, or not feasible.
- **Removable appliance** — rests on the ridges/gums and/or adjacent teeth and may increase load on remaining teeth; potential periodontal disease, fractures, occlusal/color changes, gum recession, sore ridges, food impaction, speech changes, decay, wear, and TMD. Being removable, it can also have odor, chipping, stability/retention issues, facial/lip changes, and may need periodic relines.
- **Fixed appliance** — cemented and anchored to adjoining teeth; the potential problems are the same as with **my natural teeth** (periodontal disease, fractures, occlusal/color changes, food impaction, decay, wear from grinding, TMD). Preparing teeth for a bridge carries a high risk of pulpal damage requiring root canal at additional cost.

I understand any prosthesis is a reasonable compromise — not my natural teeth; exact color
and shape can only be approximated, and daily hygiene plus regular cleanings and check-ups
are necessary for the health of my mouth and prosthesis.

**The procedure.** Dental implants are titanium anchors placed in the jawbone beneath the
gum to support artificial teeth. Forms include traditional 2-piece implants and abutments,
3 mm implants, and transitional/mini implants. Placement of implants and the making of
prostheses are **two separate treatments** with separate expenses and risks. Gum tissue is
opened to expose bone; implants are threaded into the bone, fitted snugly, and the gum
sutured over/around them; healing proceeds for **3–6 months**. Some implant types need a
second procedure to connect an attachment before the restorative phase begins. If implants
are restored on the day of surgery ("teeth in a day"), those are **for looks only** — I
cannot chew food for **4 months** and must mash food with a fork; otherwise I risk losing
the implants and restoration at additional cost. If an immediate restoration is not ideal,
an alternative (temporary partial, Essix appliance, temporary denture, or none) is used for
4–6 months. Once an implant is inserted, the entire plan must be followed on schedule or the
implant(s) may fail. During the first 1–2 weeks, dentures/removable prostheses are usually
worn for appearance only, not eating. No estimate can be made for implant longevity;
dentistry is not an exact science and no guarantees can be made.

**Risks** (contact the office immediately if any occur): swelling worsening after 48 hours;
infection; rarely, permanent loss/alteration of nerve sensation (numbness/tingling of lip,
tongue, cheek, chin, gums, teeth); rarely, temporary or permanent nerve injury from local
anesthetic injection; sinus complications; excessive or prolonged bleeding; TMJ pain or
abnormal jaw function or fracture; injury to adjacent teeth, roots, fillings, or bridgework;
bone loss / implant failure (bone does not grow around the implant); higher failure rate for
transitional/mini implants, which may also fracture during insertion or over their life
cycle.

**Benefits.** Increased chewing efficiency; improved appearance and/or speech; prevention of
future bone loss and maintenance of facial form.

**Factors that can cause failure.** Smoking, excessive alcohol, uncontrolled blood sugar,
and chewing hard foods (ice, gum, hard candy) can damage implants and cause failure; a
medical condition can compromise implant longevity.

**Candidacy.** Most people missing teeth can benefit from implants. Those with conditions
that impair healing (uncontrolled diabetes, bisphosphonate therapy, radiation/chemotherapy)
or insufficient bone density may not be candidates. During surgery it may be decided to
delay, alter, or cancel treatment — including if grafts are needed for bone build-up, tissue
(gingival) closure, and/or securing implants — and it may even be discovered mid-surgery
that I am not a candidate.

**Consent.** I acknowledge (by initialing the sections above) that the procedure has been
explained to my satisfaction, my questions answered, and I understand the risks. I am aware
a perfect result cannot be guaranteed or warranted. **I give my consent for the procedure.**

Patient: `{{patient.full_name}}` · DOB: `{{patient.dob}}` · Signature: ⟦e-signature⟧ · Date: ⟦auto⟧

> **Consent key:** `implant_surgery_consent`

## §B2. Informed Consent for Conscious Sedation **[LEGAL REVIEW]**

Please read carefully and ask any questions before signing.

Conscious sedation is a controlled, medication-induced, minimally depressed level of
consciousness — administered orally — that lets you breathe independently and respond to
stimulation or verbal command (e.g., "open your eyes"). It reduces pain, stress, and
anxiety, and often leaves little memory of treatment. You are sedated, not unconscious as
in general anesthesia; sedatives remain in your system for several hours, so **you need an
escort home**. Occasionally a patient cannot cooperate due to a cognitive, physical, or
medical condition or severe anxiety; treatment may then be rescheduled with an
anesthesiologist present for General Anesthesia at additional cost. Your dentist will
recommend the anesthesia appropriate for your needs.

**Risks include, but are not limited to:** infection, swelling, discoloration, bruising,
headache, dizziness, nausea, and vomiting. Adverse reactions — including allergic and, very
rarely, life-threatening reactions requiring hospitalization or resulting in brain damage or
death — are possible. Reflexes are delayed after sedation.

**If a chosen level of anesthesia does not relieve anxiety or pain**, in the dentist's
clinical judgment general anesthesia may be needed, which can require an anesthesiologist or
referral elsewhere at additional charge.

**For all female patients.** Anesthetics and medications may harm an unborn child or cause
birth defects; you must tell the dentist if you are or could be pregnant. If unsure, take an
over-the-counter pregnancy test the morning of the procedure and inform the doctor; if
pregnant, postpone. Medications absorbed in breast milk may temporarily affect a nursing
baby — treatment may be postponed.

*(Day-of driving/escort restrictions are in §D1 Pre-Op and §D2 Post-Op.)*

**Consent.** The sedation process has been explained to my satisfaction, my questions
answered, and I understand the risks. I am aware a perfect result cannot be guaranteed.
**I consent to the use of conscious sedation anesthesia.**

Patient: `{{patient.full_name}}` · DOB: `{{patient.dob}}` · Signature: ⟦e-signature⟧ · Date: ⟦auto⟧

> **Consent key:** `conscious_sedation_consent`

## §B3. Informed Consent for Smokers *(complete only if you use tobacco, vape, or marijuana)*

Implants in healthy non-smokers have a reported **92–98%** success rate. Implant placement
requires a blood clot and normal healing. Smoking decreases healing response; reported
success rates in smokers fall to **50–82%**. A non-smoker loses about 0.1 mm of bone around
implants in the first five years; smokers have been reported to lose bone at **10×** that
rate.

Dion Health does not take responsibility for complications in a patient who smokes at any
time after surgery. If failure or complications occur, you are solely responsible for all
costs to correct or repair them — including lab costs, labor, professional fees, supplies,
and sedation.

I understand smoking decreases the likelihood of success, **voids any warranty**, and that
there is no guarantee of services. I am solely responsible for all repair, replacement, and
correction costs resulting from smoking. **"Smoking" includes vaping and marijuana use** and
is not limited to tobacco.

Patient: `{{patient.full_name}}` · DOB: `{{patient.dob}}` · Signature: ⟦e-signature⟧ · Date: ⟦auto⟧

> **Consent key:** `smoker_consent` · Conditional — surface only when the patient reports
> tobacco/vape/marijuana use in intake.

---

# PART C — Authorizations & Acknowledgments

## §C1. HIPAA Notice of Privacy Practices — Acknowledgment *(new)*

I acknowledge that Dion Health has made available its **Notice of Privacy Practices**,
describing how my protected health information may be used and disclosed and my rights
regarding that information. I understand I may request a copy at any time and that the
Notice may be updated. **[LEGAL REVIEW]** — confirm the practice's current Notice is linked
in the signing flow.

☐ I acknowledge receipt/availability of the Notice of Privacy Practices.

> **Consent key:** `hipaa_npp_acknowledgment`

## §C2. Medical History & Medication Disclosure — Attestation *(new)*

I attest that I have provided my **complete and accurate medical history** and have reported
all known medications, allergies, and prior reactions to drugs, foods, or anesthetics, as
well as any blood/body diseases, gum or skin reactions, abnormal bleeding, or other
conditions related to my health. I understand that withholding information can seriously
affect the safety and outcome of treatment, and I will promptly report any changes.

**Authorization to coordinate care.** To support the success of treatment, I authorize Dion
Health to contact my primary care physician and specialists as needed. If not applicable, I
have indicated N/A in intake. *(Provider names/phones captured at booking/EHR intake:
`{{intake.pcp_name}}` and specialists.)*

Patient: `{{patient.full_name}}` · DOB: `{{patient.dob}}` · Signature: ⟦e-signature⟧ · Date: ⟦auto⟧

> **Consent key:** `medical_history_attestation`

## §C3. CT Scan Authorization

The purpose of your CT scan is solely to evaluate the upper and lower jaw for the planning
and placement of dental implants. It is **not** a diagnostic tool for any other condition.
For other diagnostics, you may have it interpreted by our recommended radiologist for
**$150**, or take a copy for **$300** to be interpreted by any other health professional of
your choosing, at your expense.

**Please choose one (required):**

- ☐ **WAIVER** — I elect the free CT scan and will **not** take a copy home today.
- ☐ **ACCEPTANCE** — I elect the CT scan **and** to take a copy home today for a fee of **$300**.

Patient: `{{patient.full_name}}` · DOB: `{{patient.dob}}` · Signature: ⟦e-signature⟧ · Date: ⟦auto⟧

> **Consent key:** `ct_scan_choice` (single-choice election).

## §C4. Authorization for Use of Photographic/Video Images *(optional — does not affect treatment)* **[LEGAL REVIEW]**

I authorize the use and disclosure of my photographic/video images and/or testimonial,
including medical information contained therein, to **Dion Health**, its business associates,
employees, licensees, and successors, for promotional materials — brochures, press releases,
websites, social media, education materials, and advertising activities of **Dion Health**. I
understand disclosed information may be re-disclosed and may no longer be protected by HIPAA
or the HITECH Act. **I do NOT authorize the use of my name.**

I may revoke this authorization at any time in writing via registered mail; revocation is
not retroactive. **My practitioner cannot condition treatment on whether I sign this
authorization.**

*If I choose to post publicly about my treatment, I acknowledge Dion Health may post a
truthful response even if it discloses information about my treatment; by posting publicly I
consent to waive the related privacy protections described in HIPAA and applicable state law.*
**[LEGAL REVIEW]** — this waiver-by-posting clause is aggressive; confirm enforceability.

☐ **Optional** — I authorize the use of my images/testimonial as described.

> **Consent key:** `photo_video_authorization` · **Non-gating**: must never block execution
> of the packet (No-Treatment-Conditions clause).

---

# PART D — Patient Instructions *(take-home; acknowledge receipt)*

## §D1. Sedation Pre-Operative Instructions

- A **responsible adult must escort you home** and stay with you for 24 hours. Do **not** take a taxi, bus, public transit, or walk home. Keep the seat reclined and your head back on the way home to keep your airway open. Take the whole day off and limit activity.
- If you need help from the car to the office, call **`{{coordinator.phone}}`** and we'll assist with a wheelchair.
- **Do not eat or drink 6 hours before surgery** (small sips of water for medications are OK). Diabetics may have a light snack (yogurt, toast) at least one hour before.
- Wear comfortable, loose clothing with short sleeves. Remove contact lenses. No jewelry, cosmetics, dark nail polish, or high heels (one nail must be polish-free for monitoring). Leave valuables at home.
- Take medications prescribed by your medical doctor at least one hour before — **except** your diuretic (water pill).
- If your procedure may cause bleeding (extraction, implant placement, bone/gum grafting), **stop all herbal supplements 2 weeks before treatment.**
- Diabetics on insulin: usually take half your usual morning dose and bring your blood-testing kit; ask the doctor for specifics.
- **DO NOT DRIVE TO OR FROM THE APPOINTMENT IF ON TRIAZOLAM.** Arriving without your designated driver may cancel your appointment and incur a cancellation fee.

*Driver, escort, and emergency-contact details are captured at intake
(`{{intake.driver_name}}`, `{{intake.emergency_contact}}`) and confirmed at check-in.*

☐ I acknowledge receipt of the Sedation Pre-Operative Instructions.

> **Consent key:** `sedation_preop_ack`

## §D2. Post-Operative Instructions *(sedation + implant, consolidated)*

**Immediately after sedation.** Do not drive or operate hazardous devices/machinery for 24
hours. A responsible person must stay with you until you've fully recovered. Avoid stairs
unattended; stay on the ground floor until recovered. Drink plenty of fluids. Being drowsy,
disoriented, or nauseated for 24–48 hours is normal — attend to alert and sleepy patients
alike and hold the patient's arm when walking. If symptoms worry you and you can't reach us,
go to the nearest emergency room.

**Bleeding.** Bleeding is usually minimal since the wound is sutured. For 24 hours, avoid
vigorous chewing, spitting, rinsing, and drinking through a straw. Don't pull your lip to
inspect the site.

**Swelling.** May peak 2–3 days after surgery and last up to 2–3 weeks. Keep your head
elevated. Ice packs (outside the mouth) help **only the first day**; after 24 hours switch to
a warm towel.

**Oral hygiene.** Starting the day after surgery, rinse with the prescribed mouth rinse; warm
salt-water rinses (1 tsp salt / glass warm water) may be used in between, 3–4×/day. Brush
normally but gently near the site. No Waterpik® or hydrogen-peroxide rinses for 4 weeks. Use
a chlorhexidine rinse twice daily if prescribed. Don't spit or use a straw for 2 weeks.

**Diet.** Start with nourishing liquids and soft/cold foods (ice cream, pudding, yogurt). For
large surgeries: liquids for 3 days, then soft diet up to 3 weeks until suture removal. Avoid
hot foods and sharp-edged foods (chips, pretzels); don't chew over the surgical area. Return
to a normal diet as tolerated.

**Activity.** Limit physical activity the first 24–48 hours; overexertion can cause bleeding.
Keep your head elevated when lying down; a towel on the pillow avoids staining from
blood-tinged saliva.

**Dental prosthesis.** Partials, flippers, or full dentures should not be used after surgery
unless your doctor advises; these may be adjusted at/after your first post-op visit.

**Pain medication.** Pain may last up to 3–4 weeks. In most cases a **non-narcotic** regimen
of **acetaminophen (Tylenol) + ibuprofen (Advil) taken together** is as effective as a
narcotic without the side effects. Follow narcotic directions carefully if prescribed. **⚠️
Tylenol and Vicodine both contain acetaminophen and must NOT be taken together — doing so can
cause liver damage.** Questions about interactions: call our office first, then your physician
and/or pharmacist.

**Post-op visits.** Return for all post-op visits; the first is usually 1–2 weeks after
treatment. Emergencies: call **`{{practice.emergency_phone}}`**.

I have read the financial arrangements, the post-operative instructions, and the limitations
of liability and responsibility, and I acknowledge and agree to follow all instructions.

Patient: `{{patient.full_name}}` · DOB: `{{patient.dob}}` · Signature: ⟦e-signature⟧ · Date: ⟦auto⟧

> **Consent key:** `postop_ack`

## §D3. Medication Instructions

Follow pharmacy instructions for each prescription you're given. *(All-inclusive list of
common prescriptions; follow the instructions prescribed to you and on the label.)*

- **Amoxicillin** 500 mg — Disp 15. Begin a day before your procedure — 1 tab 3×/day for 5 days.
- **Cephalexin** 500 mg — Disp 15 (alternative to amoxicillin). 1 tab every 8 hrs for 5 days.
- **Augmentin** 500 mg — Disp 10. 1 tab twice a day starting one day before the procedure.
- **Chlorhexidine** 0.12% — Disp 473 ml. Swish 15 ml twice a day for 14 days; don't spit forcefully — let it flow out.
- **Dexamethasone (Decadron)** 4 mg — Disp 6. **Not for patients with diabetes.** 2 tabs AM day of surgery; 2 tabs AM day after; 1 tab AM two days after.
- **Triazolam (Halcion)** 0.25 mg — Disp 2. Bring 2 tabs the day of surgery.
- **Ibuprofen 800 mg / Tylenol 500 mg** — one of each every 4–6 hrs as needed for pain.
- **Hydrocodone-Acetaminophen (5–325 mg)** — Disp 14. One tab every 6 hrs as needed for pain.

Preferred pharmacy: `{{intake.preferred_pharmacy}}` *(captured at intake)* · Other: ____________

☐ I acknowledge receipt of the Medication Instructions.

> **Consent key:** `medication_ack`

---

# Acknowledgment & Receipt of Copy *(new)*

By signing, I confirm that I have read (or had read to me) all parts of this document, that
my questions were answered, that I entered into it voluntarily, and that I will receive an
electronic copy of the fully executed packet.

Patient: `{{patient.full_name}}` · DOB: `{{patient.dob}}`
**Master e-signature:** ⟦drawn or typed⟧ · **Executed:** ⟦auto timestamp⟧

---

## Signing model (digital)

- The whole packet is executed by **one** patient e-signature (drawn or typed) applied to the entire record, plus an affirmative **"I have read and agree"** per section (its `consent_key`).
- **Gating vs. optional consents:** all consents are required to execute **except** `photo_video_authorization` (optional) and `smoker_consent` (shown only when intake reports tobacco/vape/marijuana use).
- The **ESIGN/UETA consent** is presented first and recorded with `esign_disclosure_version`.
- Audit trail per signing: signer name, timestamp, anti-spoofed IP, user-agent, signature image, and the agreed consent-key set — then rendered to a SHA-256'd executed PDF (existing `pdf-execute` pipeline).
