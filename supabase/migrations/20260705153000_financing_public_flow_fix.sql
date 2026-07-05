-- Fix the dead public /finance (patient-initiated & co-signer) financing flow.
--
-- send-link/route.ts and share-link.ts create the financing_applications row
-- BEFORE the patient fills out the form, so applicant_data_encrypted has no real
-- value yet. The code inserts explicit NULL (DI-4: storing '' risks accidentally
-- "decrypting" an empty string), but the column was NOT NULL (default ''), so the
-- INSERT failed with a not-null violation. Net effect: for any net-new patient
-- (no existing pending application), no financing link was ever created in prod —
-- the /finance link a patient tapped 500'd / showed an error page.
--
-- Making the column nullable lets the pre-consent row be created; the apply route
-- overwrites applicant_data_encrypted with the real encrypted PII on submit.

ALTER TABLE public.financing_applications
  ALTER COLUMN applicant_data_encrypted DROP NOT NULL;

-- Align the default with the intended null semantics (DI-4) so omitted inserts
-- also get NULL rather than ''.
ALTER TABLE public.financing_applications
  ALTER COLUMN applicant_data_encrypted SET DEFAULT NULL;
