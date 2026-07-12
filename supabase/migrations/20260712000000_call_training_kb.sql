-- ═══════════════════════════════════════════════════════════════
-- Call → AI knowledge base training
--
-- Admins can mark a completed call so its content is distilled into the
-- org's AI knowledge base (ai_memories + ai_knowledge_articles — the two
-- tables buildLiveAgentKnowledgeBlock already injects into live agents).
-- voice_calls gains a small lifecycle so the UI can show whether a call
-- has been used for training, and an undo can remove exactly the items
-- that call created.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE voice_calls
  -- NULL = never submitted. 'processing' guards double-clicks; 'added' shows
  -- the badge; 'failed' keeps the error visible so the admin can retry.
  ADD COLUMN IF NOT EXISTS training_status text
    CHECK (training_status IN ('processing', 'added', 'failed')),
  ADD COLUMN IF NOT EXISTS training_added_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS training_added_at timestamptz,
  -- The exact ai_memories / ai_knowledge_articles rows this call produced:
  -- [{ type: 'memory'|'article', id, title }]. Drives the undo path.
  ADD COLUMN IF NOT EXISTS training_item_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS training_error text;
