'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Bot, BrainCircuit, UserRound, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { AIMode } from '@/types/database'

const MODE_CONFIG = {
  auto: {
    label: 'Auto',
    description: 'AI responds autonomously',
    icon: Bot,
    dotColor: 'bg-emerald-500',
    dotPulse: true,
    bgColor: 'bg-emerald-50 dark:bg-emerald-950/30',
    borderColor: 'border-emerald-200 dark:border-emerald-800',
    textColor: 'text-emerald-700 dark:text-emerald-300',
    activeRing: 'ring-emerald-500/30',
  },
  assist: {
    label: 'Assist',
    description: 'AI drafts, you review & send',
    icon: BrainCircuit,
    dotColor: 'bg-amber-500',
    dotPulse: false,
    bgColor: 'bg-amber-50 dark:bg-amber-950/30',
    borderColor: 'border-amber-200 dark:border-amber-800',
    textColor: 'text-amber-700 dark:text-amber-300',
    activeRing: 'ring-amber-500/30',
  },
  off: {
    label: 'Off',
    description: 'Human only — AI disabled',
    icon: UserRound,
    dotColor: 'bg-gray-400',
    dotPulse: false,
    bgColor: 'bg-gray-50 dark:bg-gray-900/50',
    borderColor: 'border-gray-200 dark:border-gray-700',
    textColor: 'text-gray-600 dark:text-gray-400',
    activeRing: 'ring-gray-400/30',
  },
} as const

type AIModeToggleProps = {
  conversationId: string
  currentMode: AIMode
  onModeChange?: (newMode: AIMode) => void
  size?: 'sm' | 'md'
  showLabel?: boolean
  disabled?: boolean
}

export function AIModeToggle({
  conversationId,
  currentMode,
  onModeChange,
  size = 'md',
  showLabel = true,
  disabled = false,
}: AIModeToggleProps) {
  const [mode, setMode] = useState<AIMode>(currentMode)
  const [loading, setLoading] = useState(false)

  async function handleModeChange(newMode: AIMode) {
    if (newMode === mode || loading || disabled) return
    setLoading(true)
    const prevMode = mode
    setMode(newMode) // Optimistic

    try {
      const res = await fetch(`/api/conversations/${conversationId}/ai-mode`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai_mode: newMode }),
      })

      if (!res.ok) throw new Error('Failed to update AI mode')

      const config = MODE_CONFIG[newMode]
      toast.success(`AI mode → ${config.label}`, {
        description: config.description,
      })
      onModeChange?.(newMode)
    } catch {
      setMode(prevMode) // Rollback
      toast.error('Failed to update AI mode')
    } finally {
      setLoading(false)
    }
  }

  const config = MODE_CONFIG[mode]
  const isSmall = size === 'sm'

  return (
    <div className="flex items-center gap-2">
      {/* Status dot */}
      <div className="relative flex items-center justify-center">
        <span
          className={cn(
            'block rounded-full',
            config.dotColor,
            isSmall ? 'h-2 w-2' : 'h-2.5 w-2.5'
          )}
        />
        {config.dotPulse && (
          <span
            className={cn(
              'absolute block rounded-full animate-ping opacity-75',
              config.dotColor,
              isSmall ? 'h-2 w-2' : 'h-2.5 w-2.5'
            )}
          />
        )}
      </div>

      {/* Segmented toggle */}
      <div
        className={cn(
          'inline-flex items-center rounded-lg border p-0.5',
          isSmall ? 'gap-0' : 'gap-0.5',
          disabled ? 'opacity-50 cursor-not-allowed' : ''
        )}
      >
        {(Object.keys(MODE_CONFIG) as AIMode[]).map((m) => {
          const c = MODE_CONFIG[m]
          const Icon = c.icon
          const isActive = m === mode

          return (
            <button
              key={m}
              onClick={() => handleModeChange(m)}
              disabled={loading || disabled}
              title={c.description}
              className={cn(
                'inline-flex items-center gap-1 rounded-md font-medium transition-all duration-200',
                isSmall ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs',
                isActive
                  ? `${c.bgColor} ${c.textColor} ${c.borderColor} border ring-2 ${c.activeRing}`
                  : 'text-muted-foreground hover:bg-accent border border-transparent'
              )}
            >
              {loading && isActive ? (
                <Loader2 className={cn('animate-spin', isSmall ? 'h-2.5 w-2.5' : 'h-3 w-3')} />
              ) : (
                <Icon className={cn(isSmall ? 'h-2.5 w-2.5' : 'h-3 w-3')} />
              )}
              {showLabel && c.label}
            </button>
          )
        })}
      </div>

      {/* Label */}
      {showLabel && !isSmall && (
        <span className={cn('text-xs', config.textColor)}>{config.description}</span>
      )}
    </div>
  )
}

/**
 * Compact status-only indicator (no toggle).
 */
export function AIStatusDot({ mode, size = 'sm' }: { mode: AIMode; size?: 'sm' | 'md' }) {
  const config = MODE_CONFIG[mode]
  const isSmall = size === 'sm'

  return (
    <div className="relative flex items-center justify-center" title={`AI: ${config.label} — ${config.description}`}>
      <span
        className={cn(
          'block rounded-full',
          config.dotColor,
          isSmall ? 'h-1.5 w-1.5' : 'h-2 w-2'
        )}
      />
      {config.dotPulse && (
        <span
          className={cn(
            'absolute block rounded-full animate-ping opacity-75',
            config.dotColor,
            isSmall ? 'h-1.5 w-1.5' : 'h-2 w-2'
          )}
        />
      )}
    </div>
  )
}

/**
 * Lead-level AI override selector.
 */
export type LeadAIOverride = 'default' | 'force_on' | 'force_off' | 'assist_only'

const OVERRIDE_CONFIG = {
  default: { label: 'Use Org Default', description: 'Follow organization autopilot settings', color: 'text-muted-foreground' },
  force_on: { label: 'Force AI On', description: 'AI always active for this lead, even if org is paused', color: 'text-emerald-600' },
  force_off: { label: 'Force AI Off', description: 'No AI responses for this lead — human only', color: 'text-red-600' },
  assist_only: { label: 'Assist Only', description: 'AI drafts but never auto-sends for this lead', color: 'text-amber-600' },
} as const

type LeadAIOverrideToggleProps = {
  leadId: string
  currentOverride: LeadAIOverride
  onOverrideChange?: (newOverride: LeadAIOverride) => void
}

export function LeadAIOverrideToggle({
  leadId,
  currentOverride,
  onOverrideChange,
}: LeadAIOverrideToggleProps) {
  const [override, setOverride] = useState<LeadAIOverride>(currentOverride)
  const [loading, setLoading] = useState(false)

  async function handleChange(newOverride: LeadAIOverride) {
    if (newOverride === override || loading) return
    setLoading(true)
    const prev = override
    setOverride(newOverride)

    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ai_autopilot_override: newOverride }),
      })
      if (!res.ok) throw new Error('Failed')

      toast.success(`Lead AI override → ${OVERRIDE_CONFIG[newOverride].label}`)
      onOverrideChange?.(newOverride)
    } catch {
      setOverride(prev)
      toast.error('Failed to update AI override')
    } finally {
      setLoading(false)
    }
  }

  const config = OVERRIDE_CONFIG[override]

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className={cn('text-xs font-medium', config.color)}>{config.label}</span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {(Object.keys(OVERRIDE_CONFIG) as LeadAIOverride[]).map((o) => {
          const c = OVERRIDE_CONFIG[o]
          const isActive = o === override
          return (
            <button
              key={o}
              onClick={() => handleChange(o)}
              disabled={loading}
              className={cn(
                'text-left px-2.5 py-2 rounded-lg border text-xs transition-all',
                isActive
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                  : 'border-border hover:bg-accent'
              )}
            >
              <span className={cn('font-medium block', isActive ? c.color : 'text-foreground')}>
                {c.label}
              </span>
              <span className="text-[10px] text-muted-foreground leading-tight block mt-0.5">
                {c.description}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
