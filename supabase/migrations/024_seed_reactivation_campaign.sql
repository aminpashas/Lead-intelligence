-- Migration 024: Seed default "Reactivation" campaign per organization.
--
-- The dormant sweep (src/app/api/cron/dormant-sweep/route.ts) enrolls leads
-- with status='dormant' into the campaign whose name matches "Reactivation",
-- using the existing enroll-by-name pattern in src/lib/funnel/executor.ts.
--
-- Default sequence per brief Section 2.5 ("Default Reactivation sequence"):
--   Day 0  — SMS soft check-in
--   Day 2  — Email longer form
--   Day 5  — SMS softer offer ("send you info instead?")
--   Day 10 — Voice call (Phase 2 — seeded as SMS placeholder until Retell outbound is wired)
--   Day 14 — Mark closed_lost (handled by sweep, not as a campaign step)
--
-- Templates use {{first_name}} and {{practice_name}} placeholders supported by processTemplate().

create or replace function public.seed_reactivation_campaign(p_org_id uuid)
returns uuid as $$
declare
  v_campaign_id uuid;
begin
  -- Idempotent: don't double-seed
  select id into v_campaign_id
  from public.campaigns
  where organization_id = p_org_id
    and name = 'Reactivation'
  limit 1;

  if v_campaign_id is not null then
    return v_campaign_id;
  end if;

  insert into public.campaigns (organization_id, name, description, type, channel, status, target_criteria, metadata)
  values (
    p_org_id,
    'Reactivation',
    'Default 14-day reactivation sequence for dormant leads (no activity > 60 days).',
    'trigger',
    'multi',
    'active',
    '{"status": ["dormant"]}'::jsonb,
    '{"seeded_by": "migration_024", "auto_managed": true}'::jsonb
  )
  returning id into v_campaign_id;

  -- Step 1 — Day 0 SMS
  insert into public.campaign_steps (campaign_id, organization_id, step_number, name, channel, delay_minutes, body_template, ai_personalize)
  values (
    v_campaign_id, p_org_id, 1, 'Day 0 — SMS check-in', 'sms',
    0,
    'Hi {{first_name}}, it''s {{practice_name}}. We noticed it''s been a while since we last connected. Still interested in exploring your options? Reply YES and we''ll find a time that works.',
    false
  );

  -- Step 2 — Day 2 Email
  insert into public.campaign_steps (campaign_id, organization_id, step_number, name, channel, delay_minutes, subject, body_template, ai_personalize, exit_condition)
  values (
    v_campaign_id, p_org_id, 2, 'Day 2 — Email follow-up', 'email',
    2 * 24 * 60,  -- 2 days after Day 0
    'Still thinking it over, {{first_name}}?',
    'Hi {{first_name}},' || E'\n\n' ||
    'No pressure at all — just wanted to follow up on the inquiry you sent us at {{practice_name}}.' || E'\n\n' ||
    'A lot of patients in your situation worry about cost or recovery time. Both are easier to plan around than you''d think — financing is straightforward and the consult itself is free.' || E'\n\n' ||
    'If now isn''t the right time, just reply and let me know. Otherwise, here''s a link to grab a slot whenever works for you.' || E'\n\n' ||
    '— The team at {{practice_name}}',
    false,
    '{"if_replied": true}'::jsonb
  );

  -- Step 3 — Day 5 SMS softer offer
  insert into public.campaign_steps (campaign_id, organization_id, step_number, name, channel, delay_minutes, body_template, ai_personalize, exit_condition)
  values (
    v_campaign_id, p_org_id, 3, 'Day 5 — SMS soft offer', 'sms',
    3 * 24 * 60,  -- 3 days after Day 2 (= Day 5)
    'Hey {{first_name}} — totally understand if now isn''t the right time. Want me to send you some info to look at when you''re ready instead? No commitment.',
    false,
    '{"if_replied": true}'::jsonb
  );

  -- Step 4 — Day 10 (placeholder SMS until Phase 2 Retell outbound is wired)
  insert into public.campaign_steps (campaign_id, organization_id, step_number, name, channel, delay_minutes, body_template, ai_personalize, exit_condition)
  values (
    v_campaign_id, p_org_id, 4, 'Day 10 — Final touch (placeholder for Phase 2 Retell call)', 'sms',
    5 * 24 * 60,  -- 5 days after Day 5 (= Day 10)
    'Hi {{first_name}}, last check-in from {{practice_name}}. If we don''t hear back we''ll close the file — but the door''s always open. Reply anytime.',
    false,
    '{"if_replied": true}'::jsonb
  );

  return v_campaign_id;
end;
$$ language plpgsql;

-- Backfill: seed the campaign for all existing organizations.
do $$
declare
  org record;
begin
  for org in select id from public.organizations loop
    perform public.seed_reactivation_campaign(org.id);
  end loop;
end;
$$;

-- Auto-seed for new organizations.
create or replace function public.trigger_seed_reactivation_campaign()
returns trigger as $$
begin
  perform public.seed_reactivation_campaign(new.id);
  return new;
end;
$$ language plpgsql;

create trigger seed_reactivation_on_org_create
  after insert on public.organizations
  for each row execute function public.trigger_seed_reactivation_campaign();
