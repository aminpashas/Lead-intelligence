-- Fix: the universal audit redaction regex (20260704170000) matched email/phone/
-- ssn/dob/insurance/etc. but had NO name pattern, so every INSERT/UPDATE on leads
-- wrote the patient's first_name/last_name in CLEARTEXT into the append-only
-- audit_events snapshot — a permanent, broadly-readable plaintext PHI store.
--
-- We add TARGETED patient-name columns (first_name, last_name, middle_name,
-- maiden_name, full_name, patient_name, contact_name, guarantor_name) rather than
-- a bare `name`, so operational columns like campaign_name / stage_name /
-- practice_name / file_name stay legible and the audit log remains useful.
-- 'first_name'/'last_name' as substrings also cover patient_first_name etc.
-- Over-redaction is safe (changed_fields still records that the column changed).

create or replace function public.audit_is_sensitive_col(col text)
returns boolean
language sql
immutable
as $$
  select col ~* '(email|phone|ssn|social_security|birth|dob|insurance|passport|license|account_number|routing|iban|swift|card_number|card_last|cvv|secret|_token|token$|password|api_key|apikey|personal_details|bank|tax_id|\_ein|routing_number|address_line|street|national_id|first_name|last_name|middle_name|maiden_name|full_name|patient_name|contact_name|guarantor_name)';
$$;
