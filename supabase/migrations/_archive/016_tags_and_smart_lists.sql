-- Migration 016: Tags, Smart Lists & Campaign Performance
-- Structured tagging system with dynamic lead segments for targeted campaigns

-- ============================================
-- TAGS (first-class entities)
-- ============================================
create table public.tags (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  slug text not null,
  color text not null default '#6B7280',
  category text not null default 'custom' check (category in ('pipeline_stage', 'score', 'interest', 'behavior', 'custom')),
  description text,
  lead_count integer default 0,
  created_by uuid references public.user_profiles(id),
  created_at timestamptz default now()
);

create unique index idx_tags_org_slug on public.tags(organization_id, slug);
create index idx_tags_org_category on public.tags(organization_id, category);

-- ============================================
-- LEAD_TAGS (junction table)
-- ============================================
create table public.lead_tags (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  tagged_by uuid references public.user_profiles(id),
  tagged_at timestamptz default now()
);

create unique index idx_lead_tags_unique on public.lead_tags(lead_id, tag_id);
create index idx_lead_tags_tag on public.lead_tags(tag_id);
create index idx_lead_tags_lead on public.lead_tags(lead_id);
create index idx_lead_tags_org on public.lead_tags(organization_id);

-- ============================================
-- SMART LISTS (saved dynamic segments)
-- ============================================
create table public.smart_lists (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  icon text default 'list-filter',
  color text not null default '#6366F1',
  criteria jsonb not null default '{}',
  is_pinned boolean default false,
  lead_count integer default 0,
  last_refreshed_at timestamptz,
  created_by uuid references public.user_profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_smart_lists_org on public.smart_lists(organization_id);
create index idx_smart_lists_pinned on public.smart_lists(organization_id, is_pinned) where is_pinned = true;

-- ============================================
-- ALTER CAMPAIGNS — Smart List + KPI columns
-- ============================================
alter table public.campaigns
  add column if not exists smart_list_id uuid references public.smart_lists(id) on delete set null,
  add column if not exists total_replied integer default 0,
  add column if not exists total_opened integer default 0,
  add column if not exists reply_rate numeric(5,2) default 0,
  add column if not exists open_rate numeric(5,2) default 0,
  add column if not exists revenue_attributed numeric(12,2) default 0;

create index idx_campaigns_smart_list on public.campaigns(smart_list_id) where smart_list_id is not null;

-- ============================================
-- FUNCTION: Update tag lead_count
-- ============================================
create or replace function public.update_tag_lead_count()
returns trigger as $$
begin
  if TG_OP = 'INSERT' then
    update public.tags set lead_count = lead_count + 1 where id = NEW.tag_id;
    return NEW;
  elsif TG_OP = 'DELETE' then
    update public.tags set lead_count = greatest(lead_count - 1, 0) where id = OLD.tag_id;
    return OLD;
  end if;
  return null;
end;
$$ language plpgsql;

create trigger update_tag_count_on_lead_tag_change
  after insert or delete on public.lead_tags
  for each row execute function public.update_tag_lead_count();

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
alter table public.tags enable row level security;
alter table public.lead_tags enable row level security;
alter table public.smart_lists enable row level security;

-- Tags policies
create policy "Users can view tags in their org"
  on public.tags for select using (organization_id = public.get_user_org_id());
create policy "Users can manage tags in their org"
  on public.tags for all using (organization_id = public.get_user_org_id());

-- Lead tags policies
create policy "Users can view lead_tags in their org"
  on public.lead_tags for select using (organization_id = public.get_user_org_id());
create policy "Users can manage lead_tags in their org"
  on public.lead_tags for all using (organization_id = public.get_user_org_id());

-- Smart lists policies
create policy "Users can view smart_lists in their org"
  on public.smart_lists for select using (organization_id = public.get_user_org_id());
create policy "Users can manage smart_lists in their org"
  on public.smart_lists for all using (organization_id = public.get_user_org_id());

-- ============================================
-- TRIGGERS
-- ============================================
create trigger set_smart_lists_updated_at
  before update on public.smart_lists
  for each row execute function public.handle_updated_at();

-- ============================================
-- MIGRATE EXISTING leads.tags text[] DATA
-- ============================================
-- This creates tags from any existing text[] tags on leads
-- and populates lead_tags junction table
do $$
declare
  r record;
  tag_name text;
  tag_slug text;
  existing_tag_id uuid;
begin
  for r in (select id, organization_id, unnest(tags) as tag_val from public.leads where array_length(tags, 1) > 0) loop
    tag_name := trim(r.tag_val);
    tag_slug := lower(regexp_replace(tag_name, '[^a-zA-Z0-9]+', '-', 'g'));

    if tag_name = '' or tag_slug = '' then continue; end if;

    -- Upsert the tag
    insert into public.tags (organization_id, name, slug, color, category)
    values (r.organization_id, tag_name, tag_slug, '#6B7280', 'custom')
    on conflict (organization_id, slug) do nothing
    returning id into existing_tag_id;

    -- If no insert happened, look it up
    if existing_tag_id is null then
      select id into existing_tag_id from public.tags
      where organization_id = r.organization_id and slug = tag_slug;
    end if;

    -- Create lead_tag link
    if existing_tag_id is not null then
      insert into public.lead_tags (lead_id, tag_id, organization_id)
      values (r.id, existing_tag_id, r.organization_id)
      on conflict (lead_id, tag_id) do nothing;
    end if;
  end loop;
end;
$$;
