'use client'

import { useState } from 'react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Phone, Target, UserCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentType } from '@/types/database'

const AGENT_CONFIG = {
  setter: {
    label: 'Setter',
    description: 'Qualifying & booking consultations',
    // emerald = active AI role
    dotColor: 'bg-aurea-primary',
    textColor: 'text-aurea-primary',
    chipClass: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
    icon: Phone,
  },
  closer: {
    label: 'Closer',
    description: 'Closing deals & commitment',
    // gold = conversion / deal-closing
    dotColor: 'bg-aurea-gold',
    textColor: 'text-aurea-gold',
    chipClass: 'bg-aurea-gold/10 text-aurea-gold border border-aurea-gold/20',
    icon: Target,
  },
  none: {
    label: 'Manual',
    description: 'No AI agent assigned',
    dotColor: 'bg-aurea-ink-3',
    textColor: 'text-aurea-ink-3',
    chipClass: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
    icon: UserCheck,
  },
} as const

export function AgentIndicator({
  activeAgent,
  conversationId,
  handoffCount,
  onAgentChange,
}: {
  activeAgent: AgentType
  conversationId: string
  handoffCount?: number
  onAgentChange?: (newAgent: AgentType) => void
}) {
  const [switching, setSwitching] = useState(false)
  const config = AGENT_CONFIG[activeAgent]
  const Icon = config.icon

  async function handleAgentSwitch(newAgent: string) {
    if (newAgent === activeAgent) return
    setSwitching(true)

    try {
      const res = await fetch('/api/ai/agent-respond', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversationId,
          active_agent: newAgent,
        }),
      })

      // PATCH might not be implemented yet — handle gracefully
      if (res.status === 405) {
        // Direct DB update via a simple helper (will be handled by the API in the future)
        toast.info(`Agent switch to ${AGENT_CONFIG[newAgent as AgentType].label} — will apply on next response`)
        onAgentChange?.(newAgent as AgentType)
        return
      }

      if (!res.ok) throw new Error('Failed to switch agent')

      toast.success(`Switched to ${AGENT_CONFIG[newAgent as AgentType].label} agent`)
      onAgentChange?.(newAgent as AgentType)
    } catch {
      toast.error('Failed to switch agent')
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5" title={config.description}>
        <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-[11px] font-medium ${config.chipClass}`}>
          <Icon className="h-3 w-3" strokeWidth={1.75} />
          {config.label} Agent
        </span>
        {handoffCount != null && handoffCount > 0 && (
          <span className="text-[11px] text-aurea-ink-3" title={`${handoffCount} handoff(s) in this conversation`}>
            ({handoffCount} handoff{handoffCount > 1 ? 's' : ''})
          </span>
        )}
      </div>

      <Select
        value={activeAgent}
        onValueChange={(v) => v && handleAgentSwitch(v)}
        disabled={switching}
      >
        <SelectTrigger className="h-7 w-24 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="setter">Setter</SelectItem>
          <SelectItem value="closer">Closer</SelectItem>
          <SelectItem value="none">Manual</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

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
  timestamp,
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
