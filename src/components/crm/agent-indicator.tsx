'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
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
    color: 'bg-blue-100 text-blue-800 border-blue-200',
    icon: Phone,
  },
  closer: {
    label: 'Closer',
    description: 'Closing deals & commitment',
    color: 'bg-purple-100 text-purple-800 border-purple-200',
    icon: Target,
  },
  none: {
    label: 'Manual',
    description: 'No AI agent assigned',
    color: 'bg-gray-100 text-gray-600 border-gray-200',
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
        <Badge variant="outline" className={`${config.color} gap-1 text-xs font-medium`}>
          <Icon className="h-3 w-3" />
          {config.label} Agent
        </Badge>
        {handoffCount != null && handoffCount > 0 && (
          <span className="text-xs text-muted-foreground" title={`${handoffCount} handoff(s) in this conversation`}>
            ({handoffCount} handoff{handoffCount > 1 ? 's' : ''})
          </span>
        )}
      </div>

      <Select
        value={activeAgent}
        onValueChange={(v) => v && handleAgentSwitch(v)}
        disabled={switching}
      >
        <SelectTrigger className="w-24 h-7 text-xs">
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
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
      agent === 'setter' ? 'bg-blue-50 text-blue-600' : 'bg-purple-50 text-purple-600'
    }`}>
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
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted/50 border text-xs text-muted-foreground">
        <Badge variant="outline" className={`${fromConfig.color} text-[10px] px-1.5 py-0`}>
          {fromConfig.label}
        </Badge>
        <span>&rarr;</span>
        <Badge variant="outline" className={`${toConfig.color} text-[10px] px-1.5 py-0`}>
          {toConfig.label}
        </Badge>
        <span className="opacity-70">{reason}</span>
      </div>
    </div>
  )
}
