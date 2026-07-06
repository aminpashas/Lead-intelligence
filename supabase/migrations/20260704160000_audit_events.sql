-- ============================================================================
-- Universal, append-only audit trail (human + AI).
-- Design: docs/superpowers/specs/2026-07-04-full-audit-trail-design.md
-- Plan:   docs/superpowers/plans/2026-07-04-full-audit-trail.md
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Storage: audit_events (append-only, WORM)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  occurred_at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('user','system','ai_agent','cron','webhook')),
  actor_id uuid,
  actor_label text,
  action text not null,
  resource_type text,
  resource_id text,
  source text not null check (source in ('db_trigger','api_route','cron','webhook')),
  before jsonb,
  after jsonb,
  changed_fields text[],
  ai jsonb,
  request_id text,
  ip text,
  user_agent text,
  severity text not null default 'info' check (severity in ('info','warning','critical')),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists idx_audit_events_org_time
  on public.audit_events (organization_id, occurred_at desc);
create index if not exists idx_audit_events_resource
  on public.audit_events (organization_id, resource_type, resource_id, occurred_at desc);
create index if not exists idx_audit_events_actor
  on public.audit_events (organization_id, actor_type, occurred_at desc);
create index if not exists idx_audit_events_action
  on public.audit_events (organization_id, action);

alter table public.audit_events enable row level security;

drop policy if exists "audit_events_org_select" on public.audit_events;
create policy "audit_events_org_select" on public.audit_events
  for select using (organization_id = public.get_user_org_id());

drop policy if exists "audit_events_org_insert" on public.audit_events;
create policy "audit_events_org_insert" on public.audit_events
  for insert with check (organization_id = public.get_user_org_id());

drop policy if exists "audit_events_service_insert" on public.audit_events;
create policy "audit_events_service_insert" on public.audit_events
  for insert to service_role with check (true);

-- Append-only: reuse the existing WORM trigger (blocks UPDATE/DELETE incl. service role).
drop trigger if exists trg_audit_events_append_only on public.audit_events;
create trigger trg_audit_events_append_only
  before update or delete on public.audit_events
  for each row execute function public.prevent_row_mutation();

-- ---------------------------------------------------------------------------
-- 2. set_audit_config: let the app set app.* session GUCs for trigger attribution.
--    PostgREST cannot call set_config directly; this SECURITY DEFINER wrapper
--    accepts only the app.* namespace.
-- ---------------------------------------------------------------------------
create or replace function public.set_audit_config(setting_key text, setting_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if setting_key not like 'app.%' then
    raise exception 'set_audit_config only accepts app.* keys, got %', setting_key;
  end if;
  perform set_config(setting_key, setting_value, false);
end;
$$;

grant execute on function public.set_audit_config(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. audit_row_change: generic row-change auditor.
--    TOTAL function — never raises, so it can never roll back the business
--    transaction. Resolves actor from app.* GUCs (set_audit_config), falling
--    back to auth.uid() then 'system'. Redacts sensitive columns.
--    Denylist MIRRORS src/lib/audit/redaction.ts — keep in sync.
-- ---------------------------------------------------------------------------
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_before jsonb;
  v_after jsonb;
  v_changed text[];
  v_actor_type text;
  v_actor_id text;
  v_denylist text[];
  v_col text;
begin
  begin
    v_org := coalesce(
      (to_jsonb(NEW) ->> 'organization_id'),
      (to_jsonb(OLD) ->> 'organization_id')
    )::uuid;
    if v_org is null then
      return coalesce(NEW, OLD);
    end if;

    v_before := case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end;
    v_after  := case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end;

    v_denylist := case TG_TABLE_NAME
      when 'leads' then array['email','phone','phone_formatted','date_of_birth','insurance_provider','phone_hash','email_hash']
      when 'clinical_cases' then array['patient_email','patient_phone']
      when 'patient_profiles' then array['personal_details']
      else array[]::text[]
    end;
    foreach v_col in array v_denylist loop
      if v_before ? v_col then v_before := jsonb_set(v_before, array[v_col], '"[redacted]"'::jsonb); end if;
      if v_after  ? v_col then v_after  := jsonb_set(v_after,  array[v_col], '"[redacted]"'::jsonb); end if;
    end loop;

    if v_before is not null and v_after is not null then
      select array_agg(k.key) into v_changed
      from (select key from jsonb_object_keys(v_before || v_after) as t(key)) k
      where (v_before -> k.key) is distinct from (v_after -> k.key);
    end if;

    v_actor_type := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system');
    v_actor_id := nullif(current_setting('app.actor_id', true), '');
    if v_actor_id is null and auth.uid() is not null then
      v_actor_type := 'user';
      v_actor_id := auth.uid()::text;
    end if;

    insert into public.audit_events (
      organization_id, actor_type, actor_id, actor_label, action,
      resource_type, resource_id, source, before, after, changed_fields,
      request_id
    ) values (
      v_org,
      v_actor_type,
      case when v_actor_id ~ '^[0-9a-f-]{36}$' then v_actor_id::uuid else null end,
      nullif(current_setting('app.actor_label', true), ''),
      TG_TABLE_NAME || '.' || lower(TG_OP),
      TG_TABLE_NAME,
      coalesce((to_jsonb(NEW) ->> 'id'), (to_jsonb(OLD) ->> 'id')),
      'db_trigger',
      v_before, v_after, v_changed,
      nullif(current_setting('app.request_id', true), '')
    );
  exception when others then
    raise warning 'audit_row_change failed for %.%: %', TG_TABLE_SCHEMA, TG_TABLE_NAME, sqlerrm;
  end;
  return coalesce(NEW, OLD);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Attach the trigger to the v1 curated table set (only tables that exist).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['leads','appointments','clinical_cases','user_profiles','connector_configs'] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('drop trigger if exists trg_audit_%1$s on public.%1$I', t);
      execute format(
        'create trigger trg_audit_%1$s after insert or update or delete on public.%1$I
         for each row execute function public.audit_row_change()', t);
    end if;
  end loop;
end $$;
