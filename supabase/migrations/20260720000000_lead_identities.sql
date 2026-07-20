-- Cross-path lead identity resolution.
--
-- ROOT CAUSE: a social DM carries a display name and a PSID — never a phone or
-- an email. `ingestLead` dedups on `email_hash`/`phone_hash` only, so a social
-- lead's dedup key is always null: no match, new row, every time. Three writers
-- mint leads for the same person, each stamping a DIFFERENT correlation id:
--
--   /api/v1/leads (DGS bridge)      → external_ref = DGS uuid
--   lib/ghl/social-lead.ts          → external_ref = GHL contact id
--   lib/bridges/dion-social-lead.ts → external_ref = `messenger:<PSID>`
--
-- so none can recognise another. Result was a 100% duplication rate on
-- Messenger (6 of 6 leads duplicated before this migration; merged 2026-07-20,
-- losers snapshotted in _merge_backup_leads_20260720).
--
-- WHY A TABLE AND NOT A COLUMN: `leads` has exactly one `external_ref` and one
-- `ghl_contact_id`. A person reachable through three id namespaces does not fit
-- in two columns — the merge had to stash the overflow in `custom_fields`. A
-- join table holds N identities per lead, and the unique index below is what
-- makes it ENFORCE "one lead per identity" rather than merely record them.

create table if not exists public.lead_identities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,
  kind text not null check (kind in ('meta_psid', 'ghl_contact_id', 'dgs_lead_id')),
  value text not null,
  created_at timestamptz not null default now()
);

-- THE constraint that makes this table a dedup key: an identity resolves to at
-- most one lead per org. Deliberately excludes lead_id — including it would
-- permit the very duplication this table exists to prevent.
create unique index if not exists lead_identities_org_kind_value_key
  on public.lead_identities (organization_id, kind, value);

-- Reverse lookup: "what else do we know this lead by" (merge tooling, detail UI).
create index if not exists lead_identities_lead_idx
  on public.lead_identities (lead_id);

alter table public.lead_identities enable row level security;

create policy "Users can view lead identities in their org"
  on public.lead_identities for select using (organization_id = public.get_user_org_id());
create policy "Users can manage lead identities in their org"
  on public.lead_identities for all using (organization_id = public.get_user_org_id());

-- Backfill from the correlation ids already scattered across `leads`.
-- `on conflict do nothing`: where two rows somehow still share an id, the first
-- wins and the collision is left for the dedup path to resolve rather than
-- failing the migration.

insert into public.lead_identities (organization_id, lead_id, kind, value)
select organization_id, id, 'ghl_contact_id', ghl_contact_id
from public.leads
where ghl_contact_id is not null and ghl_contact_id <> ''
on conflict do nothing;

-- DGS bridge rows: external_ref is a bare uuid (mirrors dgs_lead_id).
insert into public.lead_identities (organization_id, lead_id, kind, value)
select organization_id, id, 'dgs_lead_id', external_ref
from public.leads
where source_type = 'gohighlevel'
  and external_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
on conflict do nothing;

-- Bus capture rows: external_ref is `<channel>:<PSID>`. Store the bare PSID so a
-- Messenger and an Instagram id for the same person stay distinguishable by
-- value while sharing one kind.
insert into public.lead_identities (organization_id, lead_id, kind, value)
select organization_id, id, 'meta_psid', split_part(external_ref, ':', 2)
from public.leads
where external_ref like 'messenger:%' or external_ref like 'instagram:%'
on conflict do nothing;

-- Ids displaced into custom_fields by the 2026-07-20 duplicate merge, so the
-- merged-away correlation ids still resolve to the surviving lead.
insert into public.lead_identities (organization_id, lead_id, kind, value)
select l.organization_id, l.id, 'ghl_contact_id', m.value ->> 'ghl_contact_id'
from public.leads l
cross join lateral jsonb_array_elements(l.custom_fields -> 'merged_from') as m(value)
where jsonb_typeof(l.custom_fields -> 'merged_from') = 'array'
  and coalesce(m.value ->> 'ghl_contact_id', '') <> ''
on conflict do nothing;

comment on table public.lead_identities is
  'Alternate correlation ids for a lead (Meta PSID, GHL contact id, DGS lead id). Lets the three independent ingest paths resolve to ONE lead when no phone/email exists to dedup on — the social-DM case, where Meta supplies only a name and a PSID.';
comment on column public.lead_identities.value is
  'The raw id. For meta_psid this is the bare PSID, NOT the `<channel>:<psid>` form stored in leads.external_ref.';
