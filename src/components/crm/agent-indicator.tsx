import type { AgentType } from '@/types/database'

// Setter = emerald (active AI role), Closer = gold (conversion), Manual = muted.
// Only label + chip styling are needed now that the header agent selector is
// gone — routing is deterministic by pipeline stage, so there's no control to
// switch it. These labels still tag which agent produced a message.
const AGENT_CONFIG = {
  setter: {
    label: 'Setter',
    chipClass: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
  },
  closer: {
    label: 'Closer',
    chipClass: 'bg-aurea-gold/10 text-aurea-gold border border-aurea-gold/20',
  },
  none: {
    label: 'Manual',
    chipClass: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
  },
} as const

/**
 * Small inline label for message bubbles showing which agent generated it.
 */
export function AgentMessageLabel({ agent }: { agent?: string }) {
  if (!agent || agent === 'none' || agent === 'fallback') return null

  const config = agent === 'setter' ? AGENT_CONFIG.setter : agent === 'closer' ? AGENT_CONFIG.closer : null
  if (!config) return null

  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${config.chipClass}`}>
      {config.label}
    </span>
  )
}

/**
 * System message displayed when an agent handoff occurs.
 */
export function HandoffMessage({
  fromAgent,
  toAgent,
  reason,
}: {
  fromAgent: string
  toAgent: string
  reason: string
  timestamp: string
}) {
  const fromConfig = AGENT_CONFIG[fromAgent as AgentType] || AGENT_CONFIG.none
  const toConfig = AGENT_CONFIG[toAgent as AgentType] || AGENT_CONFIG.none

  return (
    <div className="flex justify-center my-3">
      <div className="inline-flex items-center gap-2 rounded-full border border-aurea-border bg-aurea-surface px-3 py-1.5 text-[11px] text-aurea-ink-3">
        <span className={`inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-medium ${fromConfig.chipClass}`}>
          {fromConfig.label}
        </span>
        <span>&rarr;</span>
        <span className={`inline-flex items-center rounded border px-1.5 py-0 text-[10px] font-medium ${toConfig.chipClass}`}>
          {toConfig.label}
        </span>
        <span className="opacity-70">{reason}</span>
      </div>
    </div>
  )
}
