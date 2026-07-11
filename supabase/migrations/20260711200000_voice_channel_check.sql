-- Allow 'voice' as a conversation/message channel.
--
-- ROOT CAUSE FIX: the CHECK constraints on conversations.channel and
-- messages.channel predate the voice feature and only allowed
-- sms/email/web_chat/whatsapp. Every voice-conversation insert (inbound
-- webhook, ensureVoiceConversation, call-manager) violated the constraint and
-- was silently swallowed by best-effort catch blocks — so voice calls never
-- attached to a conversation, call markers/transcripts never reached the
-- messages thread, and the AI had no cross-call memory.
--
-- Widening a CHECK is additive: existing rows are untouched and all previously
-- valid inserts remain valid.

alter table conversations drop constraint if exists conversations_channel_check;
alter table conversations add constraint conversations_channel_check
  check (channel = any (array['sms'::text, 'email'::text, 'web_chat'::text, 'whatsapp'::text, 'voice'::text]));

alter table messages drop constraint if exists messages_channel_check;
alter table messages add constraint messages_channel_check
  check (channel = any (array['sms'::text, 'email'::text, 'web_chat'::text, 'whatsapp'::text, 'voice'::text]));
