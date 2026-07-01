-- Keyword-filter support for Smart Lists (Audiences).
-- Trigram GIN indexes make ILIKE '%term%' substring search fast on the plaintext
-- columns the keyword filter targets. Encrypted PII columns are intentionally NOT indexed.
create extension if not exists pg_trgm;

-- Lead plaintext text columns
create index if not exists idx_leads_first_name_trgm on public.leads using gin (first_name gin_trgm_ops);
create index if not exists idx_leads_last_name_trgm on public.leads using gin (last_name gin_trgm_ops);
create index if not exists idx_leads_ai_summary_trgm on public.leads using gin (ai_summary gin_trgm_ops);
create index if not exists idx_leads_dental_condition_trgm on public.leads using gin (dental_condition_details gin_trgm_ops);
create index if not exists idx_leads_current_situation_trgm on public.leads using gin (current_dental_situation gin_trgm_ops);

-- Conversation content (all messages)
create index if not exists idx_messages_body_trgm on public.messages using gin (body gin_trgm_ops);

-- Inbound-SMS keyword lookups (partial index keeps it small)
create index if not exists idx_messages_inbound_sms_body_trgm on public.messages using gin (body gin_trgm_ops)
  where direction = 'inbound' and channel = 'sms';
