/**
 * Voice Module — Public API
 *
 * Barrel export for the voice calling system.
 */

// Retell AI client
export {
  createRetellAgent,
  updateRetellAgent,
  getRetellAgent,
  createOutboundCall,
  registerInboundNumber,
  getCallDetail,
  listCalls,
  endCall,
  verifyRetellWebhook,
  VOICE_PRESETS,
  type RetellAgentConfig,
  type RetellCallConfig,
  type RetellCallResponse,
  type RetellCallDetail,
  type RetellWebhookEvent,
  type RetellLLMRequest,
  type RetellLLMResponse,
  type VoicePresetName,
} from './retell-client'

// Voice agent (AI brain adapter)
export {
  processVoiceTranscript,
  VOICE_CHANNEL_INSTRUCTIONS,
  type VoiceAgentContext,
  type VoiceAgentResult,
} from './voice-agent'

// Call lifecycle management
export {
  preCallCheck,
  initiateOutboundCall,
  handleInboundCall,
  processCallEnd,
  type PreCallCheckResult,
} from './call-manager'

// Campaign dialer
export {
  processVoiceCampaign,
  populateCampaignQueue,
  updateCampaignLeadAfterCall,
  type DialerResult,
} from './campaign-dialer'
