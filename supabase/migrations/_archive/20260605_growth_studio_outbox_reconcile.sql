-- Reconcile sweep for growth_studio_outbox.
--
-- The DGS writeback (notify_growth_studio_lead_event) uses pg_net fire-and-forget
-- and records the request id in growth_studio_outbox. pg_net writes the eventual
-- result into net._http_response (a time-limited, periodically pruned table).
--
-- supabase-js cannot read the `net` schema, so this SECURITY DEFINER function does
-- the reconciliation in-database and the cron route just calls it via RPC:
--
--   * status_code 2xx            → status='delivered', delivered_at=now()
--   * non-2xx / error_msg        → increment attempts; if attempts < max_retries
--                                  re-POST via net.http_post (capturing the NEW
--                                  request_id) and keep status='pending';
--                                  once attempts >= max_retries → status='failed'
--   * no net response row found  → if the row is older than a grace window the
--                                  response was almost certainly pruned before we
--                                  saw it; mark 'unknown' so it stops being retried
--                                  forever. Fresh rows are left 'pending' (the
--                                  response just hasn't landed yet).
--
-- Returns one row per outbox row that changed state, so the caller can summarize
-- and alert (Sentry) on transitions to 'failed'.

create or replace function public.reconcile_growth_studio_outbox(max_retries int default 5)
returns table (
  outbox_id     uuid,
  new_status    text,
  status_code   int,
  error_msg     text
)
language plpgsql
security definer
set search_path = public, net
as $$
declare
  rec        record;
  resp       record;
  cfg        record;
  body       jsonb;
  new_req_id bigint;
  -- Rows whose net response is missing and that are older than this are treated
  -- as pruned/unrecoverable rather than left pending indefinitely.
  prune_grace interval := interval '1 hour';
begin
  select * into cfg from public.growth_studio_webhook_config where id = true;

  for rec in
    select * from public.growth_studio_outbox
    where status = 'pending' and request_id is not null
    order by created_at asc
    limit 200
  loop
    -- Look up the pg_net result for this request id. The response table is pruned,
    -- so a missing row is expected for old requests.
    select r.status_code, r.error_msg
      into resp
      from net._http_response r
      where r.id = rec.request_id
      limit 1;

    if found then
      if resp.status_code is not null and resp.status_code >= 200 and resp.status_code < 300 then
        -- Delivered.
        update public.growth_studio_outbox
          set status = 'delivered',
              delivered_at = now(),
              last_error = null
          where id = rec.id;

        outbox_id := rec.id; new_status := 'delivered';
        status_code := resp.status_code; error_msg := null;
        return next;
      else
        -- Non-2xx or transport error. Decide retry vs. give up.
        if (rec.attempts + 1) >= max_retries or cfg is null or cfg.url is null then
          update public.growth_studio_outbox
            set status = 'failed',
                attempts = rec.attempts + 1,
                last_error = coalesce(resp.error_msg, 'http ' || coalesce(resp.status_code::text, 'error'))
            where id = rec.id;

          outbox_id := rec.id; new_status := 'failed';
          status_code := resp.status_code; error_msg := resp.error_msg;
          return next;
        else
          -- Re-issue the same writeback and capture the NEW request id so the next
          -- sweep tracks the retry rather than the original (already-resolved) call.
          body := jsonb_build_object(
            'customer_id', rec.organization_id,
            'stage',       rec.stage,
            'lead_id',     rec.external_ref,
            'value_cents', rec.value_cents,
            'li_lead_id',  rec.lead_id,
            'occurred_at', now()
          );

          new_req_id := net.http_post(
            url     := cfg.url,
            headers := jsonb_build_object(
                         'Content-Type', 'application/json',
                         'Authorization', 'Bearer ' || cfg.bearer
                       ),
            body    := body
          );

          update public.growth_studio_outbox
            set attempts = rec.attempts + 1,
                request_id = new_req_id,
                status = 'pending',
                last_error = coalesce(resp.error_msg, 'http ' || coalesce(resp.status_code::text, 'error'))
            where id = rec.id;

          outbox_id := rec.id; new_status := 'pending';
          status_code := resp.status_code; error_msg := resp.error_msg;
          return next;
        end if;
      end if;
    else
      -- No net response row. If old enough, the response was pruned before we
      -- reconciled it — mark 'unknown' so it isn't retried forever. Otherwise
      -- leave it pending for a later sweep.
      if now() - rec.created_at > prune_grace then
        update public.growth_studio_outbox
          set status = 'unknown',
              last_error = 'net response pruned before reconcile'
          where id = rec.id;

        outbox_id := rec.id; new_status := 'unknown';
        status_code := null; error_msg := 'net response pruned before reconcile';
        return next;
      end if;
    end if;
  end loop;

  return;
end;
$$;

-- Service-role/definer only (same posture as the outbox + config tables).
revoke all on function public.reconcile_growth_studio_outbox(int) from public, anon, authenticated;
