'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Brain, Loader2, RefreshCw, Sparkles, Target, Heart, Shield,
  DollarSign, Clock, Search, Users, Zap, AlertTriangle,
  MessageSquare, Mail, Phone, Lightbulb, TrendingUp,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  PERSONALITY_TYPES,
  type PersonalityProfile,
  type PersonalityType,
} from '@/lib/ai/personality-types'

// Trait bars use Aurea tokens via inline CSS vars; no hard-coded hex colors.
// The trait `color` field is now an Aurea semantic token class.
const TRAIT_CONFIG: Record<string, { label: string; icon: React.ReactNode; barClass: string }> = {
  decisiveness:            { label: 'Decisiveness', icon: <Zap className="h-3 w-3" strokeWidth={1.75} />,         barClass: 'bg-aurea-rose' },
  price_sensitivity:       { label: 'Price Focus',  icon: <DollarSign className="h-3 w-3" strokeWidth={1.75} />,  barClass: 'bg-aurea-amber' },
  trust_level:             { label: 'Trust',         icon: <Shield className="h-3 w-3" strokeWidth={1.75} />,      barClass: 'bg-aurea-primary' },
  emotional_expressiveness:{ label: 'Emotional',     icon: <Heart className="h-3 w-3" strokeWidth={1.75} />,       barClass: 'bg-aurea-rose' },
  detail_orientation:      { label: 'Detail Focus',  icon: <Search className="h-3 w-3" strokeWidth={1.75} />,      barClass: 'bg-aurea-ink-2' },
  urgency:                 { label: 'Urgency',        icon: <Clock className="h-3 w-3" strokeWidth={1.75} />,       barClass: 'bg-aurea-amber' },
  research_tendency:       { label: 'Research',       icon: <Search className="h-3 w-3" strokeWidth={1.75} />,      barClass: 'bg-aurea-ink-3' },
  social_proof_need:       { label: 'Social Proof',   icon: <Users className="h-3 w-3" strokeWidth={1.75} />,       barClass: 'bg-aurea-ink-2' },
}

const EMOTIONAL_EMOJI: Record<string, string> = {
  excited: '🤩', optimistic: '😊', neutral: '😐', anxious: '😰', frustrated: '😤', fearful: '😨',
}

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  sms:   <MessageSquare className="h-3 w-3" strokeWidth={1.75} />,
  email: <Mail className="h-3 w-3" strokeWidth={1.75} />,
  phone: <Phone className="h-3 w-3" strokeWidth={1.75} />,
}

interface PersonalityProfileCardProps {
  leadId: string
  initialProfile?: PersonalityProfile | null
}

export function PersonalityProfileCard({ leadId, initialProfile }: PersonalityProfileCardProps) {
  const [profile, setProfile] = useState<PersonalityProfile | null>(initialProfile || null)
  const [loading, setLoading] = useState(!initialProfile)
  const [analyzing, setAnalyzing] = useState(false)

  useEffect(() => {
    if (!initialProfile) fetchProfile()
  }, [leadId])

  async function fetchProfile() {
    setLoading(true)
    try {
      const res = await fetch(`/api/leads/${leadId}/personality`)
      if (res.ok) {
        const data = await res.json()
        if (data.personality_profile) {
          setProfile(data.personality_profile as PersonalityProfile)
        }
      }
    } finally {
      setLoading(false)
    }
  }

  async function analyzePersonality() {
    setAnalyzing(true)
    try {
      const res = await fetch(`/api/leads/${leadId}/personality`, { method: 'POST' })
      if (res.ok) {
        const data = await res.json()
        setProfile(data.personality_profile as PersonalityProfile)
        toast.success('Personality profile analyzed!')
      } else {
        const err = await res.json()
        toast.error(err.error || 'Analysis failed')
      }
    } catch {
      toast.error('Failed to analyze personality')
    } finally {
      setAnalyzing(false)
    }
  }

  if (loading) {
    return (
      <div className="aurea-card flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-aurea-ink-3" />
      </div>
    )
  }

  // No profile yet
  if (!profile) {
    return (
      <div className="aurea-card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
          <Sparkles className="h-[17px] w-[17px] text-aurea-amber" strokeWidth={1.75} />
          <h3 className="aurea-display text-[18px] text-aurea-ink">Personality Profile</h3>
        </div>
        <div className="flex flex-col items-center space-y-3 py-8 px-5 text-center">
          <p className="text-[12.5px] text-aurea-ink-3">
            Analyze this lead&apos;s communication style to get personalized engagement tips.
          </p>
          <Button size="sm" onClick={analyzePersonality} disabled={analyzing} className="gap-1.5">
            {analyzing ? (
              <><Loader2 className="h-3 w-3 animate-spin" /> Analyzing...</>
            ) : (
              <><Brain className="h-3 w-3" strokeWidth={1.75} /> Analyze Personality</>
            )}
          </Button>
        </div>
      </div>
    )
  }

  const typeInfo = PERSONALITY_TYPES[profile.primary_type]
  const secondaryInfo = profile.secondary_type ? PERSONALITY_TYPES[profile.secondary_type] : null
  const traits = profile.traits

  return (
    <div className="aurea-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-aurea-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-[17px] w-[17px] text-aurea-amber" strokeWidth={1.75} />
          <h3 className="aurea-display text-[18px] text-aurea-ink">Personality Profile</h3>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] gap-1"
          onClick={analyzePersonality}
          disabled={analyzing}
        >
          {analyzing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" strokeWidth={1.75} />}
          Re-analyze
        </Button>
      </div>
      <div className="space-y-4 p-5">
        {/* Primary Type Badge */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-aurea-surface-2 text-lg ring-1 ring-aurea-border">
            {typeInfo.emoji}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-[13.5px] text-aurea-ink">
                {typeInfo.label}
              </span>
              {secondaryInfo && (
                <span className="text-[11px] text-aurea-ink-3">
                  / {secondaryInfo.label}
                </span>
              )}
            </div>
            <p className="text-[10.5px] text-aurea-ink-3 line-clamp-1">{typeInfo.description}</p>
          </div>
          <span className="font-mono text-[10px] tabular-nums text-aurea-ink-3 shrink-0">
            {profile.confidence}%
          </span>
        </div>

        {/* Quick Stats Row */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-lg bg-aurea-surface-2 p-2 text-center">
            <p className="aurea-eyebrow mb-0.5">Mood</p>
            <p className="text-[11px] font-medium text-aurea-ink capitalize">
              {EMOTIONAL_EMOJI[profile.emotional_state] || '😐'} {profile.emotional_state}
            </p>
          </div>
          <div className="rounded-lg bg-aurea-surface-2 p-2 text-center">
            <p className="aurea-eyebrow mb-0.5">Decisions</p>
            <p className="text-[11px] font-medium text-aurea-ink capitalize">{profile.decision_style}</p>
          </div>
          <div className="rounded-lg bg-aurea-surface-2 p-2 text-center">
            <p className="aurea-eyebrow mb-0.5">Tempo</p>
            <p className="text-[11px] font-medium text-aurea-ink capitalize">{profile.communication_tempo}</p>
          </div>
        </div>

        {/* Trait Bars */}
        <div className="space-y-1.5">
          <p className="aurea-eyebrow">Behavioral Traits</p>
          <TooltipProvider>
            {Object.entries(traits).map(([key, value]) => {
              const config = TRAIT_CONFIG[key]
              if (!config) return null
              return (
                <Tooltip key={key}>
                  <TooltipTrigger asChild>
                    <span className="flex items-center gap-2 w-full">
                      <span className="flex w-16 shrink-0 items-center gap-1 text-[10px] text-aurea-ink-3 truncate">
                        {config.icon}
                        {config.label}
                      </span>
                      <span className="flex-1 h-[3px] rounded-full bg-aurea-surface-2 overflow-hidden">
                        <span
                          className={cn('block h-full rounded-full transition-all duration-500', config.barClass)}
                          style={{ width: `${value}%`, opacity: 0.8 }}
                        />
                      </span>
                      <span className="font-mono text-[9px] tabular-nums text-aurea-ink-3 w-6 text-right">{value}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="left" className="text-xs">
                    {config.label}: {value}/100
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </TooltipProvider>
        </div>

        {/* Preferred Channel */}
        {profile.preferred_channel && (
          <div className="flex items-center gap-2 rounded-lg border border-aurea-border bg-aurea-surface-2 p-2.5">
            <span className="text-aurea-ink-3">{CHANNEL_ICONS[profile.preferred_channel]}</span>
            <span className="text-[12px] text-aurea-ink-2">
              Prefers <span className="font-medium text-aurea-ink capitalize">{profile.preferred_channel}</span>
            </span>
            {profile.avg_response_time_minutes && (
              <span className="font-mono text-[10px] text-aurea-ink-3 ml-auto">
                Avg: {profile.avg_response_time_minutes < 60
                  ? `${profile.avg_response_time_minutes}m`
                  : `${Math.round(profile.avg_response_time_minutes / 60)}h`}
              </span>
            )}
          </div>
        )}

        {/* Buying Signals */}
        {profile.buying_signals.length > 0 && (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1 text-[10.5px] font-medium text-aurea-primary">
              <TrendingUp className="h-3 w-3" strokeWidth={1.75} /> Buying Signals
            </p>
            <div className="flex flex-wrap gap-1">
              {profile.buying_signals.slice(0, 3).map((sig, i) => (
                <span key={i} className="inline-flex rounded border border-aurea-primary/20 bg-aurea-primary/10 px-1.5 py-0 text-[9px] text-aurea-primary">
                  {sig}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Objections */}
        {profile.objections_raised.length > 0 && (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1 text-[10.5px] font-medium text-aurea-amber">
              <AlertTriangle className="h-3 w-3" strokeWidth={1.75} /> Objections
            </p>
            <div className="flex flex-wrap gap-1">
              {profile.objections_raised.slice(0, 3).map((obj, i) => (
                <span key={i} className="inline-flex rounded border border-aurea-amber/20 bg-aurea-amber/10 px-1.5 py-0 text-[9px] text-aurea-amber">
                  {obj}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* AI Recommendation */}
        {profile.recommended_approach && (
          <div className="rounded-lg border border-aurea-primary/20 bg-aurea-primary/5 p-3">
            <p className="mb-1.5 flex items-center gap-1 text-[10.5px] font-medium text-aurea-primary">
              <Lightbulb className="h-3 w-3" strokeWidth={1.75} /> AI Recommendation
            </p>
            <p className="text-[11px] text-aurea-ink-2 leading-relaxed">
              {profile.recommended_approach}
            </p>
          </div>
        )}

        {/* Communication Tips */}
        {profile.communication_tips.length > 0 && (
          <div className="space-y-1">
            <p className="aurea-eyebrow">Quick Tips</p>
            <ul className="space-y-0.5">
              {profile.communication_tips.slice(0, 3).map((tip, i) => (
                <li key={i} className="flex items-start gap-1 text-[10.5px] text-aurea-ink-3">
                  <span className="mt-0.5 text-aurea-primary">•</span>
                  {tip}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer */}
        <p className="font-mono text-[9px] tabular-nums text-aurea-ink-3 text-center">
          Based on {profile.messages_analyzed} messages
        </p>
      </div>
    </div>
  )
}
