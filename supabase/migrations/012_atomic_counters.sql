-- Atomic counter increment functions to prevent race conditions
-- on concurrent webhook processing (SMS + email).
-- These replace the read-then-write pattern: value = (row.value || 0) + 1

-- Increment lead SMS received counter
CREATE OR REPLACE FUNCTION increment_lead_sms_received(p_lead_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE leads
  SET total_sms_received = COALESCE(total_sms_received, 0) + 1,
      last_responded_at = NOW()
  WHERE id = p_lead_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Increment lead total messages received counter  
CREATE OR REPLACE FUNCTION increment_lead_messages_received(p_lead_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE leads
  SET total_messages_received = COALESCE(total_messages_received, 0) + 1,
      last_responded_at = NOW()
  WHERE id = p_lead_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Increment conversation counters (unread + message count)
CREATE OR REPLACE FUNCTION increment_conversation_counters(
  p_conversation_id UUID,
  p_last_message_preview TEXT DEFAULT NULL
)
RETURNS void AS $$
BEGIN
  UPDATE conversations
  SET unread_count = COALESCE(unread_count, 0) + 1,
      message_count = COALESCE(message_count, 0) + 1,
      last_message_at = NOW(),
      last_message_preview = COALESCE(p_last_message_preview, last_message_preview)
  WHERE id = p_conversation_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
