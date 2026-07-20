-- Manual team notes: let an author edit and delete their OWN notes.
--
-- `lead_activities` ships with INSERT + SELECT policies only — it is an
-- append-only activity log, the same shape as `messages`. That is the right
-- default for the 28 machine-written activity types (score updates, stage
-- changes, campaign enrolments): those are a record of what happened and must
-- never be rewritten.
--
-- Manual notes are the exception. A human typed them, so a human needs to fix a
-- typo or remove something they shouldn't have written. Without these policies
-- the UPDATE/DELETE simply match zero rows: Postgres filters them out, PostgREST
-- reports no error, and a delete silently does nothing.
--
-- Both policies are deliberately narrow on three axes, so the append-only
-- guarantee survives for everything else:
--   1. activity_type = 'note_added'  — no other activity type becomes mutable
--   2. user_id = auth.uid()          — authors touch only their own notes
--   3. organization_id = get_user_org_id() — the existing tenant boundary
--      (agency-admin aware: the function resolves an agency admin's active
--      client org, not just their home org)
--
-- The UPDATE policy carries a WITH CHECK identical to its USING clause so a row
-- cannot be edited *out* of the author's own scope — e.g. reassigning user_id to
-- someone else, moving the note to another org, or laundering it into a
-- different activity_type to make it mutable-then-something-else.

drop policy if exists "Authors can update their own notes" on public.lead_activities;
create policy "Authors can update their own notes"
  on public.lead_activities
  for update
  using (
    activity_type = 'note_added'
    and user_id = auth.uid()
    and organization_id = public.get_user_org_id()
  )
  with check (
    activity_type = 'note_added'
    and user_id = auth.uid()
    and organization_id = public.get_user_org_id()
  );

drop policy if exists "Authors can delete their own notes" on public.lead_activities;
create policy "Authors can delete their own notes"
  on public.lead_activities
  for delete
  using (
    activity_type = 'note_added'
    and user_id = auth.uid()
    and organization_id = public.get_user_org_id()
  );
