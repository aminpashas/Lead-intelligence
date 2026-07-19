-- Allow 'messenger' and 'instagram' as conversation/message channels.
--
-- ROOT CAUSE: inbound Facebook/Instagram DMs mirrored from GHL were dropped
-- before they ever reached the database — mapGhlChannel() returned null for
-- TYPE_FACEBOOK/TYPE_INSTAGRAM. Fixing that mapping alone would then fail the
-- CHECK constraints here, which predate any social channel and only allowed
-- sms/email/web_chat/whatsapp/voice.
--
-- Same shape as 20260711200000_voice_channel_check.sql (which added 'voice').
-- Widening a CHECK is backward compatible: existing rows all satisfy it.

alter table conversations drop constraint if exists conversations_channel_check;
alter table conversations add constraint conversations_channel_check
  check (channel = any (array['sms'::text, 'email'::text, 'web_chat'::text, 'whatsapp'::text, 'voice'::text, 'messenger'::text, 'instagram'::text]));

alter table messages drop constraint if exists messages_channel_check;
alter table messages add constraint messages_channel_check
  check (channel = any (array['sms'::text, 'email'::text, 'web_chat'::text, 'whatsapp'::text, 'voice'::text, 'messenger'::text, 'instagram'::text]));
