-- New orgs default to Pacific (Dion practices are West-Coast; Dion Health SF was
-- the first). Per-org timezone is still set explicitly at onboarding; this is
-- only the fallback for rows inserted without one. Drives TCPA quiet-hours
-- (see src/lib/autopilot/config.ts getLocalHourAndDay).
alter table public.organizations alter column timezone set default 'America/Los_Angeles';
