# FMR Intake Field Spec — feeding the contract's merge variables

Per the design decision (patient-entered fields live in **booking/EHR intake**, not inside
the signing flow), this maps every FMR merge field / conditional consent to its data
source and the work needed to populate it. It is the companion to:

- Template: `src/lib/contracts/templates/fmr.ts`
- Resolver: `src/lib/contracts/variables.ts`
- Master doc: `docs/fmr-contract/FMR-Contract-Corrected-Master.md`

Legend — **Status**: ✅ resolved today · 🟡 config step · 🔴 needs new capture.

---

## 1. Field → source map

| Merge field / consent | Source | Status | Action |
|---|---|---|---|
| `patient.full_name` | `clinical_cases.patient_name` | ✅ | — |
| `patient.dob` | `leads.date_of_birth` (captured in [booking-widget.tsx](../../src/components/booking/booking-widget.tsx) `dob`) | ✅ | — |
| `treatment.description` | `case_treatment_plans.plan_summary` | ✅ | clinician-set; ensure it reads like a treatment name |
| `surgery.date` | `treatment_closings.surgery_date` | ✅ | — |
| `preop.date` | — | 🔴 | add a pre-op date to `treatment_closings` (or booking) and map it |
| `financial.total_to_patient` / `deposit` / `balance_due` | `treatment_closings.contract_amount` / `deposit_amount` (computed) | ✅ | — |
| `financial.total_before_discount` / `discount_amount` | — (no discount column) | 🟡 | today: before-discount = contracted, discount = $0. Add `discount_amount` to `treatment_closings` if deals carry a discount line |
| `financial.payment_method` | `treatment_closings.financing_type` (labeled) | ✅ | — |
| `doctor.name` | `organizations.settings.practice.doctor_name` | 🟡 | set via `seed-fmr-template.ts` (`FMR_DOCTOR_NAME`) or Settings |
| `coordinator.name` / `.phone` / `.email` | `settings.practice.coordinator_*` | 🟡 | same seed step |
| `practice.emergency_phone` | `settings.practice.emergency_phone` | 🟡 | same seed step |
| `surgery.location` / `postop.location` | `settings.practice.default_location` | 🟡 | same seed step (per-case override is a future enhancement) |
| `legal.*` (entity, governing law, arbitration venue, cancellation/refund days) | `settings.legal` | 🟡 | existing org legal settings — must be filled or contract generation warns |
| `intake.preferred_pharmacy` | — | 🔴 | **new intake field** |
| `intake.pcp_name` (+ specialists) | — | 🔴 | **new intake field** |
| `intake.driver_name` (+ phone) | — | 🔴 | **new intake field** |
| `intake.emergency_contact` (+ phone) | — | 🔴 | **new intake field** |
| **smoker flag** → gates `smoker_consent` section | — | 🔴 | **new intake yes/no** (tobacco/vape/marijuana) |
| `ct_scan_choice` election | signing flow (in-contract radio) | ✅ | handled in the template, not intake |
| medical history detail (behind `medical_history_attestation`) | EHR / CareStack medical form | 🟡 | attestation references it; detailed capture is the existing medical intake |

---

## 2. Where to store the 🔴 fields

**Recommendation: one `intake` JSONB column on `treatment_closings`.** The closing is
already the per-patient, surgery-scoped row that holds `surgery_date`, `deposit_amount`,
and `records_checklist` — driver, pharmacy, PCP, emergency contact, and the smoker flag
belong to the same surgical episode. This avoids touching `leads` (which is under PII
field-encryption triggers — see `20260604_enforce_leads_pii_encrypted.sql`) and needs no
new table.

```sql
-- migration: add FMR pre-surgical intake bag
alter table public.treatment_closings
  add column if not exists intake jsonb not null default '{}'::jsonb;
-- shape:
-- {
--   "preferred_pharmacy": "CVS #1234, 500 Main St",
--   "pcp_name": "Dr. Jane Ruiz",
--   "pcp_phone": "(415) 555-0101",
--   "specialists": [{ "name": "...", "title": "...", "phone": "..." }],
--   "driver_name": "...", "driver_phone": "...",
--   "emergency_contact_name": "...", "emergency_contact_phone": "...",
--   "uses_tobacco_vape_marijuana": true,
--   "preop_date": "2026-08-01"
-- }
```

---

## 3. Where to capture them (UX)

These are surgical-prep details, not booking-time details, so they do **not** belong in the
public booking widget. Add a **"Pre-Surgical Intake"** step, surfaced two ways:

1. **Staff-entered** on the case/closing detail screen (coordinator fills during the pre-op
   call) — fastest path to go-live, no patient-facing UI.
2. **Patient self-serve** (later): a tokenized pre-op intake link (reuse the contract
   `share_token` pattern) the patient completes before signing.

Minimum viable: option 1 (a form section writing `treatment_closings.intake`). The smoker
question is a single yes/no radio.

---

## 4. Resolver wiring (when the column exists)

`variables.ts` currently defaults the `intake.*` keys to `''`. Once `treatment_closings.intake`
exists, replace those defaults with reads from the closing bag:

```ts
// in buildContractContext, after closingRow is fetched (add `intake` to its select)
const intake = (closingRow?.intake ?? {}) as Record<string, string | boolean | undefined>
// ...
'intake.preferred_pharmacy': String(intake.preferred_pharmacy ?? ''),
'intake.pcp_name':          String(intake.pcp_name ?? ''),
'intake.driver_name':       String(intake.driver_name ?? ''),
'intake.emergency_contact': [intake.emergency_contact_name, intake.emergency_contact_phone].filter(Boolean).join(' · '),
'preop.date':               formatDate(String(intake.preop_date ?? '') || null),
```

---

## 5. Conditional consent: the smoker section

`smoker_consent` is authored `required: false` in the template so it never blocks execution.
Two render rules to add at **generation** time (`src/lib/contracts/orchestrator.ts`), driven
by `intake.uses_tobacco_vape_marijuana`:

- **false** → drop the `smoker_consent` section from the generated packet (patient never sees it).
- **true** → keep it, and treat it as gating for *this* contract (require its consent key at sign).

`photo_video_authorization` stays `required: false` and always optional (No-Treatment-Conditions
clause) regardless of intake — never make it gating.

---

## 6. Punch list to reach a fully-populated FMR contract

1. 🟡 Fill `settings.legal` (entity, governing law, arbitration venue, cancellation/refund days) and `settings.practice` (doctor, coordinator, emergency phone, location) — the seed script does the `practice` half.
2. ✅ Migration: `treatment_closings.intake jsonb` — `supabase/migrations/20260702160000_fmr_treatment_closings_intake.sql` (bag also carries `discount_amount` + `preop_date`). **Apply to prod** via `supabase db query --linked -f`.
3. 🔴 Coordinator form writing `treatment_closings.intake` (the one remaining UI task).
4. ✅ Resolver reads `intake.*`, `discount`, `preop_date` from the bag (best-effort; safe pre-migration).
5. ✅ Orchestrator drops/gates `smoker_consent` from `intake.uses_tobacco`.
6. ✅ Everything else resolves from existing rows today.

Only **#1 (org settings)** and **#3 (the coordinator form)** remain before an FMR contract renders fully populated end-to-end.
