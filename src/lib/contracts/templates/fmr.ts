/**
 * Dion Health — Full Mouth Reconstruction (FMR) contract template (v9).
 *
 * Source of truth: docs/fmr-contract/FMR-Contract-Corrected-Master.md
 *
 * This is the patient-facing, e-signable packet mapped onto the contract engine's
 * section model (see ContractTemplateSection). Bodies are plain text with
 * {{variable}} merge tokens resolved at generation time by src/lib/contracts/variables.ts.
 *
 * Signing model:
 *   - ONE master signature (drawn or typed) applied to the whole record, captured at
 *     the sign step — represented here by the final `signature` section.
 *   - Each `consent` section is an affirmative "I have read and agree", keyed by
 *     consent_key on the signing audit trail.
 *   - `required: false` consents are non-gating: `smoker_consent` (shown only when
 *     intake reports tobacco/vape/marijuana) and `photo_video_authorization` (optional).
 *
 * NOTE: sections marked [LEGAL REVIEW] in the master carry binding language that
 * should be confirmed by counsel before the template is published to production.
 */

import type { ContractTemplate, ContractTemplateSection } from '@/types/database'

export const FMR_TEMPLATE_SLUG = 'fmr-full-mouth-reconstruction'
export const FMR_TEMPLATE_NAME = 'Full Mouth Reconstruction — Agreement, Consents & Instructions'

export const FMR_SECTIONS: ContractTemplateSection[] = [
  // ── Before you sign ────────────────────────────────────────────────────
  {
    id: 'voluntary_consent',
    title: 'Voluntary Consent & Right to Ask Questions',
    kind: 'boilerplate',
    required: true,
    body: `Your care and these agreements are entered into voluntarily. You have the right to ask your doctor or treatment coordinator any question before signing, to request more time, to seek a second opinion, and to decline or discontinue elective treatment. If you need an interpreter or an accessible format, tell us and we will arrange it at no cost.

By continuing, you confirm you have had the opportunity to ask questions and that your questions have been answered to your satisfaction.`,
  },
  {
    id: 'esign_consent',
    title: 'Electronic Records & Signatures Consent (ESIGN / UETA)',
    kind: 'consent',
    required: true,
    consent_key: 'esign_consent',
    body: `You agree to receive and sign these records electronically. Your electronic signature has the same legal effect as a handwritten one. You may request a paper copy at any time and may withdraw consent to electronic records before signing by contacting your treatment coordinator; withdrawing consent may delay treatment.

To sign electronically you need a device with a modern web browser and an email address or mobile number where we can reach you.

I have read and agree to the Electronic Records & Signatures Consent.`,
  },

  // ── Part A — Agreement & Financial Terms ──────────────────────────────
  {
    id: 'parties_treatment_plan',
    title: 'Parties & Treatment Plan',
    kind: 'boilerplate',
    required: true,
    body: `This agreement is between {{legal.entity_name}} ("Dion Health," "we," "us") and the patient identified below ("you").

Thank you for trusting Dion Health with your oral health care. During the course of your treatment you will work with a team of highly skilled doctors and providers. The initial treatment plan below has been diagnosed and agreed upon. It is subject to change based on clinical findings during treatment; any changes will be discussed with you at the time of findings, and any change in cost will be presented for approval before proceeding.

Patient: {{patient.full_name}}   Date of birth: {{patient.dob}}
Treatment: {{treatment.description}}
Surgery location: {{surgery.location}}   Post-operative care: {{postop.location}}
Treating doctor: {{doctor.name}}
Treatment coordinator: {{coordinator.name}} — {{coordinator.phone}} · {{coordinator.email}}`,
  },
  {
    id: 'financial_agreement',
    title: 'Financial Agreement',
    kind: 'consent',
    required: true,
    consent_key: 'financial_agreement',
    body: `Total cost of treatment: {{financial.total_before_discount_formatted}}
Discount (paid-in-full for total treatment): −{{financial.discount_amount_formatted}}
Total cost to patient: {{financial.total_to_patient_formatted}}
Non-refundable deposit (design, planning, surgical guides, facility fee, and other included costs): {{financial.deposit_amount_formatted}}
Balance due before treatment: {{financial.balance_due_formatted}}

Pre-Op appointment: {{preop.date}}   Date of surgery: {{surgery.date}}
Payment method: {{financial.payment_method}}

Payment: The initial deposit and agreed total must be paid no later than 2 weeks prior to the scheduled surgery. If payment is not received, the appointment may be cancelled and only rescheduled once the financial obligation has been met.

Late balances: Any balance 30 days past due from the dates agreed above is subject to 5% interest.

Price-Match: Dion Health will price-match a comparable, documented written treatment estimate for the same scope of care from a licensed provider, at Dion Health's discretion. Ask your treatment coordinator for details.

Refund & Cancellation Policy: The deposit is non-refundable once design, planning, or surgical guides have begun, as it covers work performed and materials ordered on your behalf. Cancellations, no-shows, or rescheduling of surgery within 48 hours may be subject to an additional fee. You may cancel elective treatment not yet begun within {{legal.cancellation_policy_days}} days of signing; refunds of amounts paid beyond the non-refundable deposit are processed within {{legal.refund_policy_days}} days.

Insurance & Assignment of Benefits: Fees quoted are your responsibility regardless of insurance. If you have coverage, we can, at your request, submit claims and accept assignment of benefits; any insurance payment is credited to your balance. You remain responsible for amounts insurance does not pay.

I HAVE READ, UNDERSTAND, AND AGREE TO THE FINANCIAL ARRANGEMENTS ABOVE.`,
  },
  {
    id: 'warranty_and_responsibilities',
    title: 'Warranty, Maintenance & Patient Responsibilities',
    kind: 'consent',
    required: true,
    consent_key: 'warranty_and_responsibilities',
    body: `What our support covers. It may be necessary for the doctor to perform remakes during the first six months following the procedure; this is normal and included so long as you follow all treatment instructions. If clinical issues arise, a new prosthesis may be remade with your consent. Once aesthetics are finalized, a prosthesis will not be remade due to a change of mind. Crowns and veneers may chip during the six-month adjustment period; such chips are a normal part of the process. If you chip or break a portion of the prosthetics within 12 months after treatment, a replacement may be provided for a fee.

What our support does not cover. One-year maintenance does not include free repair or replacement for: prosthesis loss, discoloration, excessive wear, inappropriate use (any use not prescribed by the prosthodontist), or neglect or abuse of the prosthesis. Any adjustment or alteration of the prosthesis by someone other than an authorized representative of our choosing automatically voids our support obligation. If you want treatment redone after successful clinical delivery, or want to change the agreed plan, full price applies.

Your maintenance duties. You are required to: maintain a high level of oral hygiene; have up to four professional cleanings each year; wear an occlusal night guard every night; and keep implants and prosthesis clean through daily care and regular checkups. You may still need other treatment in the future (periodontal, orthodontic, restorative), which is your responsibility and not included in this plan.

Conditions and habits that void the warranty and shift responsibility to you. Treatment failure caused by grinding/clenching (bruxism), malocclusion, untreated sleep apnea, or by a medical condition (e.g., uncontrolled diabetes, auto-immune disease) or a habit that complicates healing — including smoking, vaping, and marijuana use — is your responsibility; Dion Health is not obligated to reimburse or redo the treatment.

No guarantee of biological outcomes. There is no guarantee on osseointegration of implants or integration of bone grafts; these depend on your immune system, medical condition, and hygiene and are outside our control. Additional bone grafting or implant work — including removing and replacing implants — may be necessary; any resulting change in plan and cost will be discussed with you before proceeding.

Outside providers. Treatment from an unaffiliated provider outside the Dion Health network automatically removes Dion Health from any obligation to support your treatment, unless we specifically referred you to that outside specialist.`,
  },
  {
    id: 'general_provisions',
    title: 'General Provisions (incl. Arbitration)',
    kind: 'consent',
    required: true,
    consent_key: 'general_provisions',
    body: `Arbitration of Disputes. Any dispute between you and the doctor/office will be arbitrated and fully resolved by a local arbitrator licensed, qualified, and experienced in prosthesis treatments of the nature performed on you. Either party may give written notice requesting to meet and resolve the dispute; the parties will seek to resolve it reasonably within thirty (30) days. If unresolved, either party may give notice of arbitration, to be conducted in the county where the procedure was performed ({{legal.arbitration_venue}}). The parties shall appoint a mutually agreed arbitrator with at least five (5) years' experience deciding disputes of this nature; if they cannot agree within thirty (30) days, either party may apply to the local office of the American Arbitration Association (or another qualified professional association, "AAA") for appointment. The arbitrator decides under AAA rules and enters a binding award; a party that must compel arbitration, or that unsuccessfully challenges or fails to comply with the award, is liable for the other party's costs of suit including reasonable attorneys', expert-witness, and enforcement fees. Enforcement may be carried out in the local Superior Court.

Governing Law. This agreement is governed by the laws of {{legal.governing_law}}.

Entire Agreement. This document (all parts) is the entire agreement between you and Dion Health regarding this treatment and supersedes prior discussions or estimates.

Amendments. Changes to the treatment plan or cost are effective only when documented and agreed by both parties (electronically or in writing).

Severability. If any provision is held unenforceable, the remaining provisions stay in effect.

Assignment. You may not assign this agreement. Dion Health may assign it to a successor practice on notice to you.

Notices. Notices to you are sent to the email, phone, or address on file; notices to Dion Health go to your treatment coordinator.

I have read and agree to the General Provisions, including binding arbitration.`,
  },

  // ── Part B — Informed Consents ────────────────────────────────────────
  {
    id: 'implant_surgery_consent',
    title: 'Informed Consent for Implant Surgery',
    kind: 'consent',
    required: true,
    consent_key: 'implant_surgery_consent',
    body: `Alternatives to implant treatment. You may choose:
• No replacement of missing teeth — possible drift of adjacent/opposing teeth, collapse of arch integrity, and worsening of present complaints; later repair may become more difficult, costlier, or not feasible.
• Removable appliance — rests on the ridges/gums and/or adjacent teeth and may increase load on remaining teeth; potential periodontal disease, fractures, occlusal/color changes, gum recession, sore ridges, food impaction, speech changes, decay, wear, and TMD. Being removable, it can also have odor, chipping, stability/retention issues, facial/lip changes, and may need periodic relines.
• Fixed appliance — cemented and anchored to adjoining teeth; the potential problems are the same as with my natural teeth (periodontal disease, fractures, occlusal/color changes, food impaction, decay, wear from grinding, TMD). Preparing teeth for a bridge carries a high risk of pulpal damage requiring root canal at additional cost.

I understand any prosthesis is a reasonable compromise — not my natural teeth; exact color and shape can only be approximated, and daily hygiene plus regular cleanings and check-ups are necessary for the health of my mouth and prosthesis.

The procedure. Dental implants are titanium anchors placed in the jawbone beneath the gum to support artificial teeth. Placement of implants and the making of prostheses are two separate treatments with separate expenses and risks. Gum tissue is opened to expose bone; implants are threaded into the bone, fitted snugly, and the gum sutured over/around them; healing proceeds for 3–6 months. If implants are restored on the day of surgery ("teeth in a day"), those are for looks only — I cannot chew food for 4 months and must mash food with a fork; otherwise I risk losing the implants and restoration at additional cost. Once an implant is inserted, the entire plan must be followed on schedule or the implant(s) may fail. No estimate can be made for implant longevity; dentistry is not an exact science and no guarantees can be made.

Risks (contact the office immediately if any occur): swelling worsening after 48 hours; infection; rarely, permanent loss/alteration of nerve sensation (numbness/tingling of lip, tongue, cheek, chin, gums, teeth); rarely, temporary or permanent nerve injury from local anesthetic injection; sinus complications; excessive or prolonged bleeding; TMJ pain or abnormal jaw function or fracture; injury to adjacent teeth, roots, fillings, or bridgework; bone loss / implant failure; higher failure rate for transitional/mini implants, which may also fracture.

Benefits. Increased chewing efficiency; improved appearance and/or speech; prevention of future bone loss and maintenance of facial form.

Factors that can cause failure. Smoking, excessive alcohol, uncontrolled blood sugar, and chewing hard foods (ice, gum, hard candy) can damage implants and cause failure; a medical condition can compromise implant longevity.

Candidacy. Most people missing teeth can benefit from implants. Those with conditions that impair healing (uncontrolled diabetes, bisphosphonate therapy, radiation/chemotherapy) or insufficient bone density may not be candidates. During surgery it may be decided to delay, alter, or cancel treatment — including if grafts are needed for bone build-up, tissue (gingival) closure, and/or securing implants — and it may even be discovered mid-surgery that I am not a candidate.

Consent. I acknowledge (by initialing the sections above) that the procedure has been explained to my satisfaction, my questions answered, and I understand the risks. I am aware a perfect result cannot be guaranteed or warranted. I give my consent for the procedure.`,
  },
  {
    id: 'conscious_sedation_consent',
    title: 'Informed Consent for Conscious Sedation',
    kind: 'consent',
    required: true,
    consent_key: 'conscious_sedation_consent',
    body: `Conscious sedation is a controlled, medication-induced, minimally depressed level of consciousness — administered orally — that lets you breathe independently and respond to stimulation or verbal command (e.g., "open your eyes"). It reduces pain, stress, and anxiety, and often leaves little memory of treatment. You are sedated, not unconscious as in general anesthesia; sedatives remain in your system for several hours, so you need an escort home. Occasionally a patient cannot cooperate due to a cognitive, physical, or medical condition or severe anxiety; treatment may then be rescheduled with an anesthesiologist present for General Anesthesia at additional cost. Your dentist will recommend the anesthesia appropriate for your needs.

Risks include, but are not limited to: infection, swelling, discoloration, bruising, headache, dizziness, nausea, and vomiting. Adverse reactions — including allergic and, very rarely, life-threatening reactions requiring hospitalization or resulting in brain damage or death — are possible. Reflexes are delayed after sedation.

If a chosen level of anesthesia does not relieve anxiety or pain, in the dentist's clinical judgment general anesthesia may be needed, which can require an anesthesiologist or referral elsewhere at additional charge.

For all female patients. Anesthetics and medications may harm an unborn child or cause birth defects; you must tell the dentist if you are or could be pregnant. If unsure, take an over-the-counter pregnancy test the morning of the procedure and inform the doctor; if pregnant, postpone. Medications absorbed in breast milk may temporarily affect a nursing baby — treatment may be postponed.

Consent. The sedation process has been explained to my satisfaction, my questions answered, and I understand the risks. I am aware a perfect result cannot be guaranteed. I consent to the use of conscious sedation anesthesia.`,
  },
  {
    id: 'smoker_consent',
    title: 'Informed Consent for Smokers',
    kind: 'consent',
    required: false, // conditional — shown only when intake reports tobacco/vape/marijuana use
    consent_key: 'smoker_consent',
    body: `Complete this section only if you use tobacco, vape, or marijuana.

Implants in healthy non-smokers have a reported 92–98% success rate. Implant placement requires a blood clot and normal healing. Smoking decreases healing response; reported success rates in smokers fall to 50–82%. A non-smoker loses about 0.1 mm of bone around implants in the first five years; smokers have been reported to lose bone at 10× that rate.

Dion Health does not take responsibility for complications in a patient who smokes at any time after surgery. If failure or complications occur, you are solely responsible for all costs to correct or repair them — including lab costs, labor, professional fees, supplies, and sedation.

I understand smoking decreases the likelihood of success, voids any warranty, and that there is no guarantee of services. I am solely responsible for all repair, replacement, and correction costs resulting from smoking. "Smoking" includes vaping and marijuana use and is not limited to tobacco.`,
  },

  // ── Part C — Authorizations & Acknowledgments ─────────────────────────
  {
    id: 'hipaa_npp_acknowledgment',
    title: 'HIPAA Notice of Privacy Practices — Acknowledgment',
    kind: 'consent',
    required: true,
    consent_key: 'hipaa_npp_acknowledgment',
    body: `I acknowledge that Dion Health has made available its Notice of Privacy Practices, describing how my protected health information may be used and disclosed and my rights regarding that information. I understand I may request a copy at any time and that the Notice may be updated.

I acknowledge receipt/availability of the Notice of Privacy Practices.`,
  },
  {
    id: 'medical_history_attestation',
    title: 'Medical History & Medication Disclosure — Attestation',
    kind: 'consent',
    required: true,
    consent_key: 'medical_history_attestation',
    body: `I attest that I have provided my complete and accurate medical history and have reported all known medications, allergies, and prior reactions to drugs, foods, or anesthetics, as well as any blood/body diseases, gum or skin reactions, abnormal bleeding, or other conditions related to my health. I understand that withholding information can seriously affect the safety and outcome of treatment, and I will promptly report any changes.

Authorization to coordinate care. To support the success of treatment, I authorize Dion Health to contact my primary care physician and specialists as needed. If not applicable, I have indicated N/A in intake.`,
  },
  {
    id: 'ct_scan_choice',
    title: 'CT Scan Authorization',
    kind: 'consent',
    required: true,
    consent_key: 'ct_scan_choice',
    body: `The purpose of your CT scan is solely to evaluate the upper and lower jaw for the planning and placement of dental implants. It is not a diagnostic tool for any other condition. For other diagnostics, you may have it interpreted by our recommended radiologist for $150, or take a copy for $300 to be interpreted by any other health professional of your choosing, at your expense.

Please choose one (required):
• WAIVER — I elect the free CT scan and will NOT take a copy home today.
• ACCEPTANCE — I elect the CT scan AND to take a copy home today for a fee of $300.`,
  },
  {
    id: 'photo_video_authorization',
    title: 'Authorization for Use of Photographic/Video Images (optional)',
    kind: 'consent',
    required: false, // optional — must not gate execution (No-Treatment-Conditions clause)
    consent_key: 'photo_video_authorization',
    body: `This authorization is optional and does not affect your treatment.

I authorize the use and disclosure of my photographic/video images and/or testimonial, including medical information contained therein, to Dion Health, its business associates, employees, licensees, and successors, for promotional materials — brochures, press releases, websites, social media, education materials, and advertising activities of Dion Health. I understand disclosed information may be re-disclosed and may no longer be protected by HIPAA or the HITECH Act. I do NOT authorize the use of my name.

I may revoke this authorization at any time in writing via registered mail; revocation is not retroactive. My practitioner cannot condition treatment on whether I sign this authorization.

If I choose to post publicly about my treatment, I acknowledge Dion Health may post a truthful response even if it discloses information about my treatment; by posting publicly I consent to waive the related privacy protections described in HIPAA and applicable state law.

Optional — I authorize the use of my images/testimonial as described.`,
  },

  // ── Part D — Patient Instructions (acknowledge receipt) ───────────────
  {
    id: 'sedation_preop_ack',
    title: 'Sedation Pre-Operative Instructions',
    kind: 'consent',
    required: true,
    consent_key: 'sedation_preop_ack',
    body: `• A responsible adult must escort you home and stay with you for 24 hours. Do NOT take a taxi, bus, public transit, or walk home. Keep the seat reclined and your head back on the way home to keep your airway open. Take the whole day off and limit activity.
• If you need help from the car to the office, call {{coordinator.phone}} and we'll assist with a wheelchair.
• Do not eat or drink 6 hours before surgery (small sips of water for medications are OK). Diabetics may have a light snack (yogurt, toast) at least one hour before.
• Wear comfortable, loose clothing with short sleeves. Remove contact lenses. No jewelry, cosmetics, dark nail polish, or high heels (one nail must be polish-free for monitoring). Leave valuables at home.
• Take medications prescribed by your medical doctor at least one hour before — except your diuretic (water pill).
• If your procedure may cause bleeding (extraction, implant placement, bone/gum grafting), stop all herbal supplements 2 weeks before treatment.
• Diabetics on insulin: usually take half your usual morning dose and bring your blood-testing kit; ask the doctor for specifics.
• DO NOT DRIVE TO OR FROM THE APPOINTMENT IF ON TRIAZOLAM. Arriving without your designated driver may cancel your appointment and incur a cancellation fee.

I acknowledge receipt of the Sedation Pre-Operative Instructions.`,
  },
  {
    id: 'postop_ack',
    title: 'Post-Operative Instructions',
    kind: 'consent',
    required: true,
    consent_key: 'postop_ack',
    body: `Immediately after sedation. Do not drive or operate hazardous devices/machinery for 24 hours. A responsible person must stay with you until you've fully recovered. Avoid stairs unattended; stay on the ground floor until recovered. Drink plenty of fluids. Being drowsy, disoriented, or nauseated for 24–48 hours is normal — attend to alert and sleepy patients alike and hold the patient's arm when walking. If symptoms worry you and you can't reach us, go to the nearest emergency room.

Bleeding. Bleeding is usually minimal since the wound is sutured. For 24 hours, avoid vigorous chewing, spitting, rinsing, and drinking through a straw. Don't pull your lip to inspect the site.

Swelling. May peak 2–3 days after surgery and last up to 2–3 weeks. Keep your head elevated. Ice packs (outside the mouth) help only the first day; after 24 hours switch to a warm towel.

Oral hygiene. Starting the day after surgery, rinse with the prescribed mouth rinse; warm salt-water rinses (1 tsp salt / glass warm water) may be used in between, 3–4×/day. Brush normally but gently near the site. No Waterpik or hydrogen-peroxide rinses for 4 weeks. Use a chlorhexidine rinse twice daily if prescribed. Don't spit or use a straw for 2 weeks.

Diet. Start with nourishing liquids and soft/cold foods (ice cream, pudding, yogurt). For large surgeries: liquids for 3 days, then soft diet up to 3 weeks until suture removal. Avoid hot foods and sharp-edged foods (chips, pretzels); don't chew over the surgical area. Return to a normal diet as tolerated.

Activity. Limit physical activity the first 24–48 hours; overexertion can cause bleeding. Keep your head elevated when lying down; a towel on the pillow avoids staining from blood-tinged saliva.

Dental prosthesis. Partials, flippers, or full dentures should not be used after surgery unless your doctor advises; these may be adjusted at/after your first post-op visit.

Pain medication. Pain may last up to 3–4 weeks. In most cases a non-narcotic regimen of acetaminophen (Tylenol) + ibuprofen (Advil) taken together is as effective as a narcotic without the side effects. Follow narcotic directions carefully if prescribed. WARNING: Tylenol and Vicodin both contain acetaminophen and must NOT be taken together — doing so can cause liver damage. Questions about interactions: call our office first, then your physician and/or pharmacist.

Post-op visits. Return for all post-op visits; the first is usually 1–2 weeks after treatment. Emergencies: call {{practice.emergency_phone}}.

I have read the financial arrangements, the post-operative instructions, and the limitations of liability and responsibility, and I acknowledge and agree to follow all instructions.`,
  },
  {
    id: 'medication_ack',
    title: 'Medication Instructions',
    kind: 'consent',
    required: true,
    consent_key: 'medication_ack',
    body: `Follow pharmacy instructions for each prescription you're given. This is an all-inclusive list of common prescriptions; follow the instructions prescribed to you and on the label.

• Amoxicillin 500 mg — Disp 15. Begin a day before your procedure — 1 tab 3×/day for 5 days.
• Cephalexin 500 mg — Disp 15 (alternative to amoxicillin). 1 tab every 8 hrs for 5 days.
• Augmentin 500 mg — Disp 10. 1 tab twice a day starting one day before the procedure.
• Chlorhexidine 0.12% — Disp 473 ml. Swish 15 ml twice a day for 14 days; don't spit forcefully — let it flow out.
• Dexamethasone (Decadron) 4 mg — Disp 6. Not for patients with diabetes. 2 tabs AM day of surgery; 2 tabs AM day after; 1 tab AM two days after.
• Triazolam (Halcion) 0.25 mg — Disp 2. Bring 2 tabs the day of surgery.
• Ibuprofen 800 mg / Tylenol 500 mg — one of each every 4–6 hrs as needed for pain.
• Hydrocodone-Acetaminophen (5–325 mg) — Disp 14. One tab every 6 hrs as needed for pain.

Preferred pharmacy: {{intake.preferred_pharmacy}}

I acknowledge receipt of the Medication Instructions.`,
  },

  // ── Execution ─────────────────────────────────────────────────────────
  {
    id: 'acknowledgment_and_signature',
    title: 'Acknowledgment & Receipt of Copy',
    kind: 'signature',
    required: true,
    body: `By signing, I confirm that I have read (or had read to me) all parts of this document, that my questions were answered, that I entered into it voluntarily, and that I will receive an electronic copy of the fully executed packet.

Patient: {{patient.full_name}}   Date of birth: {{patient.dob}}`,
  },
]

/**
 * Merge variables the FMR template expects. Pre-flight validation fails fast before
 * generation when any are missing from the resolved context.
 */
export const FMR_REQUIRED_VARIABLES: string[] = [
  'legal.entity_name',
  'legal.governing_law',
  'legal.arbitration_venue',
  'legal.cancellation_policy_days',
  'legal.refund_policy_days',
  'patient.full_name',
  'patient.dob',
  'treatment.description',
  'doctor.name',
  'coordinator.name',
  'coordinator.phone',
  'coordinator.email',
  'practice.emergency_phone',
  'surgery.location',
  'postop.location',
  'surgery.date',
  'preop.date',
  'financial.total_before_discount_formatted',
  'financial.discount_amount_formatted',
  'financial.total_to_patient_formatted',
  'financial.deposit_amount_formatted',
  'financial.balance_due_formatted',
  'financial.payment_method',
  'intake.preferred_pharmacy',
]

export type FmrTemplateSeed = Pick<
  ContractTemplate,
  'name' | 'slug' | 'sections' | 'required_variables'
>

export const FMR_TEMPLATE_SEED: FmrTemplateSeed = {
  name: FMR_TEMPLATE_NAME,
  slug: FMR_TEMPLATE_SLUG,
  sections: FMR_SECTIONS,
  required_variables: FMR_REQUIRED_VARIABLES,
}
