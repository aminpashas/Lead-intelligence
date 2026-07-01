'use client'

import { formatDistanceToNow } from 'date-fns'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Phone, Mail, Brain } from 'lucide-react'
import type { Lead } from '@/types/database'

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
}: {
  lead: Lead
  onClick?: () => void
}) {
  const initials = `${lead.first_name?.[0] || ''}${lead.last_name?.[0] || ''}`.toUpperCase() || '?'

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

        {lead.dental_condition && (
          <span className="max-w-[120px] truncate rounded-md bg-aurea-surface-2 px-2 py-0.5 text-[11px] text-aurea-ink-2 ring-1 ring-aurea-border">
            {lead.dental_condition.replace(/_/g, ' ')}
          </span>
        )}
      </div>

      {lead.ai_summary && (
        <p className="mt-2 line-clamp-2 text-[11.5px] text-aurea-ink-3">
          {lead.ai_summary}
        </p>
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
