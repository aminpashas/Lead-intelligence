# Archived legacy migrations

These 78 hand-numbered files (`001_…` through `20260627_…`) are **historical /
design reference only**. They are no longer part of the active migration chain.

## Why

They never corresponded to the production migration history and could not be
replayed to rebuild the schema — a Supabase preview branch built from them failed
after 17 files (missing `agency_admin`, `is_admin_role()`, the real
`user_profiles_*` policy names, etc.). See [`docs/MIGRATION_DRIFT.md`](../../../docs/MIGRATION_DRIFT.md).

## Replacement

The active schema is now a single baseline captured directly from production:

    supabase/migrations/20260627230000_remote_baseline.sql

It was produced with `supabase db dump --linked` (pg_dump output — dependency-
ordered and replayable on an empty database) on 2026-06-27, after the C1/R1/R2
security fixes were applied. Going forward, author each change as a new timestamped
migration applied via `apply_migration` (the channel that has been registering
cleanly in `supabase_migrations.schema_migrations`).

These files are kept for provenance/audit; do not add to or re-run them.
