'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
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

const TRAIT_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  decisiveness: { label: 'Decisiveness', icon: <Zap className="h-3 w-3" />, color: '#ef4444' },
  price_sensitivity: { label: 'Price Focus', icon: <DollarSign className="h-3 w-3" />, color: '#f59e0b' },
  trust_level: { label: 'Trust', icon: <Shield className="h-3 w-3" />, color: '#22c55e' },
  emotional_expressiveness: { label: 'Emotional', icon: <Heart className="h-3 w-3" />, color: '#ec4899' },
  detail_orientation: { label: 'Detail Focus', icon: <Search className="h-3 w-3" />, color: '#3b82f6' },
  urgency: { label: 'Urgency', icon: <Clock className="h-3 w-3" />, color: '#f97316' },
  research_tendency: { label: 'Research', icon: <Search className="h-3 w-3" />, color: '#06b6d4' },
  social_proof_need: { label: 'Social Proof', icon: <Users className="h-3 w-3" />, color: '#8b5cf6' },
}

const EMOTIONAL_EMOJI: Record<string, string> = {
  excited: '🤩', optimistic: '😊', neutral: '😐', anxious: '😰', frustrated: '😤', fearful: '😨',
}

const CHANNEL_ICONS: Record<string, React.ReactNode> = {
  sms: <MessageSquare className="h-3 w-3" />,
  email: <Mail className="h-3 w-3" />,
  phone: <Phone className="h-3 w-3" />,
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
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  // No profile yet
  if (!profile) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" />
            Personality Profile
          </CardTitle>
        </CardHeader>
        <CardContent className="text-center space-y-3 py-4">
          <p className="text-xs text-muted-foreground">
            Analyze this lead&apos;s communication style to get personalized engagement tips.
          </p>
          <Button size="sm" onClick={analyzePersonality} disabled={analyzing} className="gap-1.5">
            {analyzing ? (
              <><Loader2 className="h-3 w-3 animate-spin" /> Analyzing...</>
            ) : (
              <><Brain className="h-3 w-3" /> Analyze Personality</>
            )}
          </Button>
        </CardContent>
      </Card>
    )
  }

  const typeInfo = PERSONALITY_TYPES[profile.primary_type]
  const secondaryInfo = profile.secondary_type ? PERSONALITY_TYPES[profile.secondary_type] : null
  const traits = profile.traits

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" />
            Personality Profile
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[10px] gap-1"
            onClick={analyzePersonality}
            disabled={analyzing}
          >
            {analyzing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Re-analyze
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Primary Type Badge */}
        <div className="flex items-center gap-2">
          <div
            className="h-10 w-10 rounded-lg flex items-center justify-center text-lg"
            style={{ backgroundColor: typeInfo.color + '15' }}
          >
            {typeInfo.emoji}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-sm" style={{ color: typeInfo.color }}>
                {typeInfo.label}
              </span>
              {secondaryInfo && (
                <span className="text-xs text-muted-foreground">
                  / {secondaryInfo.label}
                </span>
              )}
            </div>
            <p className="text-[10px] text-muted-foreground line-clamp-1">{typeInfo.description}</p>
          </div>
          <Badge variant="outline" className="text-[9px] h-5 shrink-0">
            {profile.confidence}% conf
          </Badge>
        </div>

        {/* Quick Stats Row */}
        <div className="grid grid-cols-3 gap-2">
          <div className="text-center p-1.5 rounded bg-muted/50">
            <p className="text-[10px] text-muted-foreground">Mood</p>
            <p className="text-xs font-medium capitalize">
              {EMOTIONAL_EMOJI[profile.emotional_state] || '😐'} {profile.emotional_state}
            </p>
          </div>
          <div className="text-center p-1.5 rounded bg-muted/50">
            <p className="text-[10px] text-muted-foreground">Decisions</p>
            <p className="text-xs font-medium capitalize">{profile.decision_style}</p>
          </div>
          <div className="text-center p-1.5 rounded bg-muted/50">
            <p className="text-[10px] text-muted-foreground">Tempo</p>
            <p className="text-xs font-medium capitalize">{profile.communication_tempo}</p>
          </div>
        </div>

        {/* Trait Bars */}
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Behavioral Traits
          </p>
          <TooltipProvider>
            {Object.entries(traits).map(([key, value]) => {
              const config = TRAIT_CONFIG[key]
              if (!config) return null
              return (
                <Tooltip key={key}>
                  <TooltipTrigger>
                    <span className="flex items-center gap-2 w-full">
                      <span className="text-[10px] text-muted-foreground w-16 truncate flex items-center gap-1">
                        {config.icon}
                        {config.label}
                      </span>
                      <span className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                        <span
                          className="block h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${value}%`,
                            backgroundColor: config.color,
                            opacity: 0.8,
                          }}
                        />
                      </span>
                      <span className="text-[9px] text-muted-foreground w-6 text-right">{value}</span>
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
          <div className="flex items-center gap-2 p-2 rounded bg-accent/50">
            {CHANNEL_ICONS[profile.preferred_channel]}
            <span className="text-xs">
              Prefers <span className="font-medium capitalize">{profile.preferred_channel}</span>
            </span>
            {profile.avg_response_time_minutes && (
              <span className="text-[10px] text-muted-foreground ml-auto">
                Avg response: {profile.avg_response_time_minutes < 60
                  ? `${profile.avg_response_time_minutes}m`
                  : `${Math.round(profile.avg_response_time_minutes / 60)}h`}
              </span>
            )}
          </div>
        )}

        {/* Buying Signals */}
        {profile.buying_signals.length > 0 && (
          <div className="space-y-1">
            <p className="text-[10px] font-medium text-green-600 flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> Buying Signals
            </p>
            <div className="flex flex-wrap gap-1">
              {profile.buying_signals.slice(0, 3).map((sig, i) => (
                <Badge key={i} variant="outline" className="text-[9px] bg-green-50 dark:bg-green-950/20 text-green-700">
                  {sig}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Objections */}
        {profile.objections_raised.length > 0 && (
          <div className="space-y-1">
            <p className="text-[10px] font-medium text-amber-600 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> Objections
            </p>
            <div className="flex flex-wrap gap-1">
              {profile.objections_raised.slice(0, 3).map((obj, i) => (
                <Badge key={i} variant="outline" className="text-[9px] bg-amber-50 dark:bg-amber-950/20 text-amber-700">
                  {obj}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* AI Recommendation */}
        {profile.recommended_approach && (
          <div className="p-2 rounded-lg bg-primary/5 border border-primary/10">
            <p className="text-[10px] font-medium text-primary flex items-center gap-1 mb-1">
              <Lightbulb className="h-3 w-3" /> AI Recommendation
            </p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {profile.recommended_approach}
            </p>
          </div>
        )}

        {/* Communication Tips */}
        {profile.communication_tips.length > 0 && (
          <div className="space-y-1">
            <p className="text-[10px] font-medium text-muted-foreground">Quick Tips</p>
            <ul className="space-y-0.5">
              {profile.communication_tips.slice(0, 3).map((tip, i) => (
                <li key={i} className="text-[10px] text-muted-foreground flex items-start gap-1">
                  <span className="text-primary mt-0.5">•</span>
                  {tip}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Footer */}
        <p className="text-[9px] text-muted-foreground text-center">
          Based on {profile.messages_analyzed} messages
        </p>
      </CardContent>
    </Card>
  )
}
