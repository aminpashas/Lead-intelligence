-- Conversation threads + single-flight workflow lock.
--
-- PROBLEM: a single SMS/email conversation can carry several distinct topics at
-- once — a nurture "here's a patient story" touch, a scheduling "here are your
-- open slots" reply, a financing follow-up. Today every workflow (inbound
-- auto-respond, the follow-up-sequences cron, speed-to-lead, campaigns) composes
-- and sends into the ONE conversation row independently, with nothing
-- coordinating them. Two workflows firing in the same beat produce the collision
-- in the field: the agent sends a patient-story nurture and a scheduling reply
-- back to back, reading as two agents talking over each other.
--
-- This migration adds two things:
--
--  1. conversation_threads — sub-threads WITHIN a conversation, one per topic
--     (scheduling, nurture, financing, …). Messages carry a thread_id so each
--     topic stays legible instead of interleaving in one flat log.
--
--  2. conversation_workflow_locks + claim/release RPCs — a short-lived,
--     lease-based single-flight lock keyed on the conversation. Before a workflow
--     composes+sends it must CLAIM the conversation; a second workflow that finds
--     a live lease held by someone else stands down instead of firing. The lease
--     auto-expires (TTL) so a crashed holder never wedges the conversation.

-- ============================================
-- CONVERSATION THREADS
-- ============================================
create table if not exists public.conversation_threads (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  lead_id uuid not null references public.leads(id) on delete cascade,

  -- The topic this thread tracks. Canonical values used by the app:
  --   scheduling | nurture | financing | clinical | reminder | reengagement | general
  -- Left as free text (not a CHECK enum) so new topics can ship without a
  -- migration; the library owns the canonical list.
  topic text not null default 'general',
  title text,

  -- open   = the live topic, may still receive touches
  -- resolved = the topic concluded (booked, answered, opted out of it)
  -- superseded = folded into another thread / abandoned
  status text not null default 'open' check (status in ('open', 'resolved', 'superseded')),

  -- Which workflow opened the thread (observability only; not an ownership gate).
  opened_by text,

  last_message_at timestamptz,
  last_message_preview text,
  message_count integer not null default 0,

  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- At most one OPEN thread per (conversation, topic): a workflow re-using a topic
-- lands on the existing open thread instead of spawning duplicates. Resolved /
-- superseded threads are exempt so history accumulates.
create unique index if not exists conversation_threads_one_open_per_topic
  on public.conversation_threads (conversation_id, topic)
  where status = 'open';

-- "List the threads on this conversation, newest activity first."
create index if not exists conversation_threads_convo_idx
  on public.conversation_threads (conversation_id, last_message_at desc nulls last);

create index if not exists conversation_threads_lead_idx
  on public.conversation_threads (lead_id);

-- Messages get an optional thread pointer. Nullable + ON DELETE SET NULL so a
-- pruned thread never takes its messages with it, and legacy rows keep working.
alter table public.messages
  add column if not exists thread_id uuid references public.conversation_threads(id) on delete set null;

create index if not exists idx_messages_thread on public.messages(thread_id, created_at);

alter table public.conversation_threads enable row level security;

create policy "Users can view conversation threads in their org"
  on public.conversation_threads for select
  using (organization_id = public.get_user_org_id());

create policy "Users can manage conversation threads in their org"
  on public.conversation_threads for all
  using (organization_id = public.get_user_org_id());

create trigger set_conversation_threads_updated_at
  before update on public.conversation_threads
  for each row execute function public.handle_updated_at();

comment on table public.conversation_threads is
  'Topic sub-threads inside a single conversation (scheduling, nurture, financing, …). One open thread per topic keeps concurrent topics legible and prevents workflows from talking over each other.';

-- ============================================
-- WORKFLOW SINGLE-FLIGHT LOCK
-- ============================================
-- One row per conversation while a workflow is actively composing/sending. The
-- PK on conversation_id is what makes the claim atomic under concurrency.
create table if not exists public.conversation_workflow_locks (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  holder text not null,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists conversation_workflow_locks_expiry_idx
  on public.conversation_workflow_locks (expires_at);

alter table public.conversation_workflow_locks enable row level security;

-- Read-only visibility for staff/debugging; all writes go through the SECURITY
-- DEFINER RPCs below (service role), never direct client writes.
create policy "Users can view workflow locks in their org"
  on public.conversation_workflow_locks for select
  using (organization_id = public.get_user_org_id());

comment on table public.conversation_workflow_locks is
  'Lease-based single-flight lock: at most one workflow may hold a conversation at a time. Claimed/refreshed/released via claim_conversation_workflow / release_conversation_workflow. Leases auto-expire so a crashed holder cannot wedge the conversation.';

-- Atomically take or refresh the lease. Returns acquired=false (with the current
-- incumbent) when a live lease is held by a DIFFERENT workflow.
--   - fresh conversation            → INSERT wins → acquired
--   - lease expired                 → stolen      → acquired
--   - same holder (re-entrant)      → refreshed   → acquired
--   - live lease, different holder  → blocked     → NOT acquired
create or replace function public.claim_conversation_workflow(
  p_conversation_id uuid,
  p_organization_id uuid,
  p_workflow text,
  p_ttl_seconds integer default 120
)
returns table(acquired boolean, holder text, expires_at timestamptz)
as $$
declare
  v_now timestamptz := now();
  v_expires timestamptz := now() + make_interval(secs => greatest(coalesce(p_ttl_seconds, 120), 1));
  v_holder text;
  v_expires_out timestamptz;
begin
  insert into public.conversation_workflow_locks as l
    (conversation_id, organization_id, holder, claimed_at, expires_at)
  values (p_conversation_id, p_organization_id, p_workflow, v_now, v_expires)
  on conflict (conversation_id) do update
    set holder = excluded.holder,
        organization_id = excluded.organization_id,
        claimed_at = excluded.claimed_at,
        expires_at = excluded.expires_at
    where l.expires_at <= v_now          -- previous lease lapsed → steal
       or l.holder = excluded.holder      -- same workflow → refresh in place
  returning l.holder, l.expires_at into v_holder, v_expires_out;

  if found then
    return query select true, v_holder, v_expires_out;
    return;
  end if;

  -- Blocked by a live lease held by someone else — report the incumbent so the
  -- caller can log who owns the conversation right now.
  select l.holder, l.expires_at into v_holder, v_expires_out
    from public.conversation_workflow_locks l
    where l.conversation_id = p_conversation_id;
  return query select false, v_holder, v_expires_out;
end;
$$ language plpgsql security definer;

-- Atomic thread-activity bump (message count + last-activity stamp). Mirrors
-- increment_conversation_counters so concurrent sends don't clobber the count.
create or replace function public.increment_conversation_thread_activity(
  p_thread_id uuid,
  p_last_message_preview text default null
)
returns void as $$
begin
  update public.conversation_threads
  set message_count = coalesce(message_count, 0) + 1,
      last_message_at = now(),
      last_message_preview = coalesce(p_last_message_preview, last_message_preview),
      updated_at = now()
  where id = p_thread_id;
end;
$$ language plpgsql security definer;

-- Release the lease, but only if THIS workflow still holds it (a stale release
-- from a workflow whose lease was already stolen must not drop the new holder's).
create or replace function public.release_conversation_workflow(
  p_conversation_id uuid,
  p_workflow text
)
returns boolean as $$
declare
  v_deleted integer;
begin
  delete from public.conversation_workflow_locks
    where conversation_id = p_conversation_id
      and holder = p_workflow;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$ language plpgsql security definer;
