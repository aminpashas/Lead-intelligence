-- Financing "apply on behalf" (substitute applicant) support.
--
-- A patient can forward their /finance/{token} link to a family member or friend
-- with stronger credit, who then applies AS THE SOLE APPLICANT on the patient's
-- behalf (NOT a joint/co-signed loan — the soft credit pull runs on the person
-- who fills the form). The applicant's identity already lands in
-- `applicant_data_encrypted`, and the patient linkage is preserved via `lead_id`.
--
-- These two NON-PII descriptive columns record *that* a substitute applied and
-- how they relate to the patient, so staff can see it in the CRM without
-- decrypting the applicant record and without conflating the borrower with the
-- patient.

alter table public.financing_applications
  add column if not exists applied_on_behalf boolean not null default false,
  add column if not exists applicant_relationship text;

comment on column public.financing_applications.applied_on_behalf is
  'True when someone other than the patient filled out the application (substitute applicant). The applicant PII in applicant_data_encrypted is the borrower; lead_id still points to the patient.';
comment on column public.financing_applications.applicant_relationship is
  'How the substitute applicant relates to the patient (spouse, parent, adult_child, other_family, friend, other). Null when applied_on_behalf is false.';
