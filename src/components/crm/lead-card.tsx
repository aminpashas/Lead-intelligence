'use client'

import { formatDistanceToNow, format } from 'date-fns'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Phone, Mail, Brain, TrendingUp, ArrowRight, Clock } from 'lucide-react'
import type { Lead } from '@/types/database'
import type { StageSuggestion } from '@/lib/pipeline/suggest-stage'
import type { TimelineEnrollment } from '@/lib/pipeline/contacted-state'
import { closingQueueState } from '@/lib/pipeline/closing'
import { LeadCadenceBadge } from './lead-cadence-badge'

// Lead qualification chips — hot=rose, warm=amber, cold=neutral ink
const qualificationColors: Record<string, string> = {
  hot: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20',
  warm: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  cold: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
  unqualified: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
  unscored: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
}

export function LeadCard({
  lead,
  onClick,
  closeProbability,
  suggestion,
  onApplySuggestion,
  cadence,
}: {
  lead: Lead
  onClick?: () => void
  closeProbability?: number
  suggestion?: StageSuggestion | null
  onApplySuggestion?: (leadId: string, toStageId: string) => void
  /** Present only for Following Up / Engaged cards — drives the Day-N cadence badge. */
  cadence?: { enrollment: TimelineEnrollment | null; engaged: boolean }
}) {
  const initials = `${lead.first_name?.[0] || ''}${lead.last_name?.[0] || ''}`.toUpperCase() || '?'

  // Deliberating pill: a deal the closer parked to circle back. "waiting" (timer
  // in the future) reads muted; "due" (timer arrived, or no timer) reads as an
  // action cue. Non-deliberating deals render nothing here.
  const deliberating =
    lead.closing_temperature === 'deliberating'
      ? closingQueueState(lead.closing_temperature, lead.closing_follow_up_at, Date.now())
      : null

  return (
    <div
      className="aurea-card cursor-pointer p-3 transition-colors hover:bg-aurea-surface-2"
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <Avatar className="h-9 w-9 shrink-0">
          <AvatarFallback className="text-xs">{initials}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-aurea-ink">
            {lead.first_name} {lead.last_name}
          </p>
          <div className="mt-0.5 flex items-center gap-2">
            {lead.phone && <Phone className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />}
            {lead.email && <Mail className="h-3 w-3 text-aurea-ink-3" strokeWidth={1.75} />}
            <span className="truncate text-[11px] text-aurea-ink-3">
              {lead.city ? `${lead.city}, ${lead.state}` : lead.source_type?.replace(/_/g, ' ')}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        {lead.ai_qualification !== 'unscored' && (
          <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${qualificationColors[lead.ai_qualification]}`}>
            <Brain className="h-3 w-3" strokeWidth={1.75} />
            <span className="font-mono tabular-nums">{lead.ai_score}</span>
          </span>
        )}

        {typeof closeProbability === 'number' && (
          <span
            className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${
              closeProbability >= 0.6
                ? 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20'
                : closeProbability >= 0.3
                ? 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20'
                : 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border'
            }`}
            title="Estimated probability of closing"
          >
            <TrendingUp className="h-3 w-3" strokeWidth={1.75} />
            <span className="font-mono tabular-nums">{Math.round(closeProbability * 100)}%</span>
          </span>
        )}

        {lead.dental_condition && (
          <span className="max-w-[120px] truncate rounded-md bg-aurea-surface-2 px-2 py-0.5 text-[11px] text-aurea-ink-2 ring-1 ring-aurea-border">
            {lead.dental_condition.replace(/_/g, ' ')}
          </span>
        )}

        {cadence && (
          <LeadCadenceBadge enrollment={cadence.enrollment} engaged={cadence.engaged} />
        )}

        {deliberating && (
          <span
            className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ${
              deliberating === 'due'
                ? 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20'
                : 'bg-violet-500/10 text-violet-600 border border-violet-500/20'
            }`}
            title={
              lead.closing_follow_up_at
                ? `Deliberating — follow up ${format(new Date(lead.closing_follow_up_at), 'MMM d, yyyy')}`
                : 'Deliberating — no follow-up date set'
            }
          >
            <Clock className="h-3 w-3" strokeWidth={1.75} />
            {deliberating === 'due'
              ? lead.closing_follow_up_at
                ? `Due ${format(new Date(lead.closing_follow_up_at), 'MMM d')}`
                : 'Follow up'
              : `Deliberating · ${format(new Date(lead.closing_follow_up_at!), 'MMM d')}`}
          </span>
        )}
      </div>

      {lead.ai_summary && (
        <p className="mt-2 line-clamp-2 text-[11.5px] text-aurea-ink-3">
          {lead.ai_summary}
        </p>
      )}

      {suggestion && onApplySuggestion && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onApplySuggestion(lead.id, suggestion.toStageId) }}
          className="mt-2 flex w-full items-center justify-between gap-2 rounded-md border border-aurea-primary/20 bg-aurea-primary/5 px-2 py-1.5 text-left text-[11px] text-aurea-ink transition-colors hover:bg-aurea-primary/10"
          title={suggestion.reason}
        >
          <span className="truncate"><span className="text-aurea-ink-3">Suggest:</span> move to {suggestion.toStageName}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-aurea-primary" strokeWidth={2} />
        </button>
      )}

      <div className="mt-2 flex items-center justify-between border-t border-aurea-border pt-2">
        <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
          {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
        </span>
        {lead.treatment_value && (
          <span className="font-mono text-[12px] font-medium tabular-nums text-aurea-primary">
            ${lead.treatment_value.toLocaleString()}
          </span>
        )}
      </div>
    </div>
  )
}
