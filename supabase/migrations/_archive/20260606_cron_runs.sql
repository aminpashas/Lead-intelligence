-- Cron heartbeat / observability table.
--
-- The reliability lesson behind this: a cron that returns 200 is NOT proof it did
-- work — an unconfigured connector, an empty Vault secret, or a swallowed error all
-- produce a "successful" no-op. Every cron wrapped with withCron() (src/lib/cron/
-- with-cron.ts) writes one row here per run with its real outcome, so the daily
-- ops-digest can flag a cron that has gone stale (no heartbeat within its expected
-- window) or whose last run failed — instead of the failure vanishing silently.
--
-- status:
--   'ok'      → ran and did work (items_processed may be 0, which is logged, not
--               assumed-healthy)
--   'skipped' → nothing to do (e.g. no connector configured) — a healthy no-op
--   'failed'  → the handler threw; `error` holds the message

create table if not exists public.cron_runs (
  id              uuid primary key default gen_random_uuid(),
  cron            text not null,
  status          text not null check (status in ('ok', 'skipped', 'failed')),
  items_processed int  not null default 0,
  duration_ms     int,
  error           text,
  ran_at          timestamptz not null default now()
);

alter table public.cron_runs enable row level security;
-- No policies → service role / definer functions only (same posture as
-- growth_studio_outbox and the connector config tables).

-- Health reads fetch the latest row per cron; spend reporting may scan by time.
create index if not exists idx_cron_runs_cron_ran_at on public.cron_runs (cron, ran_at desc);
