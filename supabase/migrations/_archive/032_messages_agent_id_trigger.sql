-- ════════════════════════════════════════════════════════════════
-- Migration 032: Auto-attribute messages.agent_id
--
-- Migration 030 backfilled historic AI messages, but going forward
-- there are 10+ insert sites across messaging / autopilot / voice /
-- campaigns that would each need to pass agent_id. A trigger is the
-- single source of truth: on insert, if agent_id is NULL AND the
-- message is AI-authored, resolve it from conversations.active_agent
-- for the org. Deterministic, idempotent, matches the backfill.
--
-- Phase A of the AI Agent KPI Dashboard system.
-- ════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.attribute_message_to_agent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_agent_id uuid;
BEGIN
  -- Only attribute AI-authored messages that don't already have an agent
  IF NEW.agent_id IS NOT NULL OR NEW.sender_type <> 'ai' THEN
    RETURN NEW;
  END IF;

  -- Resolve the conversation's active agent role
  SELECT active_agent INTO v_role
    FROM conversations
   WHERE id = NEW.conversation_id;

  IF v_role IS NULL OR v_role NOT IN ('setter', 'closer') THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_agent_id
    FROM ai_agents
   WHERE organization_id = NEW.organization_id
     AND role = v_role
     AND is_active = true
   LIMIT 1;

  NEW.agent_id := v_agent_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attribute_message_to_agent ON messages;
CREATE TRIGGER trg_attribute_message_to_agent
  BEFORE INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION public.attribute_message_to_agent();
