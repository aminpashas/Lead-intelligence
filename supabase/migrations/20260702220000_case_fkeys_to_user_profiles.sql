-- Fix: clinical_cases.created_by / assigned_doctor_id referenced auth.users,
-- so every PostgREST embed hint (`user_profiles!clinical_cases_*_fkey`) in
-- /api/cases, /api/cases/[id] and the patient portal failed with "could not
-- find a relationship" — the cases list has 500'd since it shipped and the
-- patient share-link 404'd. user_profiles.id IS auth.users.id (1:1), so
-- re-pointing the FKs at user_profiles is semantically identical and makes
-- the embeds resolve.
ALTER TABLE public.clinical_cases DROP CONSTRAINT IF EXISTS clinical_cases_created_by_fkey;
ALTER TABLE public.clinical_cases ADD CONSTRAINT clinical_cases_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.user_profiles(id);

ALTER TABLE public.clinical_cases DROP CONSTRAINT IF EXISTS clinical_cases_assigned_doctor_id_fkey;
ALTER TABLE public.clinical_cases ADD CONSTRAINT clinical_cases_assigned_doctor_id_fkey
  FOREIGN KEY (assigned_doctor_id) REFERENCES public.user_profiles(id) ON DELETE SET NULL;

-- The cases routes/UI select user_profiles.specialty (doctor specialty shown
-- to patients) but the column never shipped — add it.
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS specialty text;

NOTIFY pgrst, 'reload schema';
