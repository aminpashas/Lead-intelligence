-- Attachment URLs on a message (patient photos sent over social DM).
--
-- Inbound Facebook/Instagram DMs frequently carry an image and an EMPTY body —
-- GHL puts the file on `attachments[]` and leaves `body` blank. The GHL
-- normalizer treated an empty body as "no context" and dropped the message
-- outright, so a patient photographing their teeth and sending it to the
-- practice page produced *nothing* in LI: no message, no thread bump, no alert.
--
-- For an implant practice that photo is often the highest-signal thing in the
-- whole conversation, so it gets a first-class column rather than being buried
-- in `metadata`.
--
-- `email_attachments` already exists but is email-specific (it stores name/size
-- objects from the Resend path); this is the generic URL list for every channel.
alter table public.messages
  add column if not exists attachments jsonb not null default '[]'::jsonb;

comment on column public.messages.attachments is
  'Array of attachment URLs carried by this message (e.g. images on a Messenger/Instagram DM). Empty array when none. A message may have attachments and an empty body.';

-- Partial index: "find messages that actually have attachments" is the only
-- query shape, and attachment-bearing messages are a small minority.
create index if not exists idx_messages_with_attachments
  on public.messages (organization_id, created_at desc)
  where jsonb_array_length(attachments) > 0;
