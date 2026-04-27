-- Migration 029b: Pin search_path on the 3 functions added by migrations 023 + 024.
--
-- Remediates the Supabase security advisor warning `function_search_path_mutable`
-- (lint 0011). Without an explicit search_path a SECURITY DEFINER function inherits
-- the caller's search_path, which a malicious caller could manipulate to inject
-- a same-named function/table in a custom schema and trick the SECURITY DEFINER
-- function into reading/writing the wrong object.
--
-- See https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable

ALTER FUNCTION public.log_consent_change()                  SET search_path = public, pg_temp;
ALTER FUNCTION public.seed_reactivation_campaign(uuid)      SET search_path = public, pg_temp;
ALTER FUNCTION public.trigger_seed_reactivation_campaign()  SET search_path = public, pg_temp;
