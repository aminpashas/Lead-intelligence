-- Backfill the cost_events ledger from historical messages (outbound SMS) and voice_calls.
--
-- The panels + invoicing compute live, so this backfill is purely to give the ledger an
-- invoice-grade history for future reconciliation. It is:
--   • idempotent  — NOT EXISTS on (service, source_table, source_id) so re-runs are safe
--   • tagged      — metadata.backfill = true, so backfilled rows are identifiable
--   • reversible  — delete where metadata->>'backfill' = 'true'
-- Markup is snapshotted from billing_settings (or the 200% / 3× house default). Rates match
-- src/lib/billing/pricing.ts (SMS 1.1¢/segment, voice 8¢/min). Inbound SMS is intentionally not
-- re-billed, so only outbound messages are ledgered.

-- ── Outbound SMS ─────────────────────────────────────────────────────────────
insert into public.cost_events
  (organization_id, service, status, event_at, source_table, source_id, external_id,
   quantity, unit, cost_cents, billable_cents, markup_pct, metadata)
select
  m.organization_id,
  'sms',
  'final',
  m.created_at,
  'messages',
  m.id,
  m.external_id,
  ceil(greatest(length(coalesce(m.body, '')), 1) / 160.0) as quantity,
  'segments',
  ceil(greatest(length(coalesce(m.body, '')), 1) / 160.0) * 1.1 as cost_cents,
  ceil(greatest(length(coalesce(m.body, '')), 1) / 160.0) * 1.1
    * (1 + coalesce((bs.markups->>'sms')::numeric, 200) / 100.0) as billable_cents,
  coalesce((bs.markups->>'sms')::numeric, 200) as markup_pct,
  jsonb_build_object('backfill', true, 'lead_id', m.lead_id)
from public.messages m
left join public.billing_settings bs on bs.organization_id = m.organization_id
where m.channel = 'sms' and m.direction = 'outbound'
  and not exists (
    select 1 from public.cost_events ce
    where ce.service = 'sms' and ce.source_table = 'messages' and ce.source_id = m.id
  );

-- ── Voice ────────────────────────────────────────────────────────────────────
insert into public.cost_events
  (organization_id, service, status, event_at, source_table, source_id, external_id,
   quantity, unit, cost_cents, billable_cents, markup_pct, metadata)
select
  v.organization_id,
  'voice',
  'final',
  v.created_at,
  'voice_calls',
  v.id,
  v.retell_call_id,
  v.duration_seconds,
  'seconds',
  (v.duration_seconds / 60.0) * 8 as cost_cents,
  (v.duration_seconds / 60.0) * 8
    * (1 + coalesce((bs.markups->>'voice')::numeric, 200) / 100.0) as billable_cents,
  coalesce((bs.markups->>'voice')::numeric, 200) as markup_pct,
  jsonb_build_object('backfill', true, 'lead_id', v.lead_id)
from public.voice_calls v
left join public.billing_settings bs on bs.organization_id = v.organization_id
where coalesce(v.duration_seconds, 0) > 0
  and not exists (
    select 1 from public.cost_events ce
    where ce.service = 'voice' and ce.source_table = 'voice_calls' and ce.source_id = v.id
  );
