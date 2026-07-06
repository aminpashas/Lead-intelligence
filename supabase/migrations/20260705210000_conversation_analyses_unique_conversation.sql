-- Persist conversation analyses reliably.
--
-- The app writes one analysis per conversation via
--   upsert(..., { onConflict: 'conversation_id' })
-- but the table only ever had a PRIMARY KEY on `id` — there was no unique
-- constraint matching that conflict target. Postgres/PostgREST therefore
-- rejected every upsert (error 42P10), the app's narrow error handling swallowed
-- it, and NOTHING was ever persisted (0 rows in prod). The panel still showed the
-- live-streamed result, so the analysis silently vanished on the next refresh.
--
-- Adding the unique constraint makes the existing upsert idempotent: one row per
-- conversation, updated in place on re-analyze. This fixes persistence for the
-- currently-deployed code immediately (no redeploy needed).

-- Defensive dedup so this is safe in any environment that already has rows
-- (prod is currently empty). Keep the most recently analyzed row per conversation.
delete from public.conversation_analyses a
using public.conversation_analyses b
where a.conversation_id = b.conversation_id
  and (a.analyzed_at, a.ctid) < (b.analyzed_at, b.ctid);

alter table public.conversation_analyses
  add constraint conversation_analyses_conversation_id_key unique (conversation_id);
