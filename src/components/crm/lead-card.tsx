'use client'

import { formatDistanceToNow } from 'date-fns'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Phone, Mail, Brain } from 'lucide-react'
import type { Lead } from '@/types/database'

const qualificationColors: Record<string, string> = {
  hot: 'bg-red-500/10 text-red-700 border-red-200',
  warm: 'bg-orange-500/10 text-orange-700 border-orange-200',
  cold: 'bg-blue-500/10 text-blue-700 border-blue-200',
  unqualified: 'bg-gray-500/10 text-gray-700 border-gray-200',
  unscored: 'bg-gray-500/10 text-gray-500 border-gray-200',
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
      className="rounded-lg border bg-card p-3 shadow-sm hover:shadow-md transition-shadow cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-start gap-3">
        <Avatar className="h-9 w-9 shrink-0">
          <AvatarFallback className="text-xs">{initials}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">
            {lead.first_name} {lead.last_name}
          </p>
          <div className="flex items-center gap-2 mt-0.5">
            {lead.phone && <Phone className="h-3 w-3 text-muted-foreground" />}
            {lead.email && <Mail className="h-3 w-3 text-muted-foreground" />}
            <span className="text-xs text-muted-foreground truncate">
              {lead.city ? `${lead.city}, ${lead.state}` : lead.source_type?.replace(/_/g, ' ')}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-2.5">
        {lead.ai_qualification !== 'unscored' && (
          <Badge variant="outline" className={qualificationColors[lead.ai_qualification]}>
            <Brain className="h-3 w-3 mr-1" />
            {lead.ai_score}
          </Badge>
        )}

        {lead.dental_condition && (
          <Badge variant="secondary" className="text-xs truncate max-w-[120px]">
            {lead.dental_condition.replace(/_/g, ' ')}
          </Badge>
        )}
      </div>

      {lead.ai_summary && (
        <p className="text-xs text-muted-foreground mt-2 line-clamp-2">
          {lead.ai_summary}
        </p>
      )}

      <div className="flex items-center justify-between mt-2 pt-2 border-t">
        <span className="text-xs text-muted-foreground">
          {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
        </span>
        {lead.treatment_value && (
          <span className="text-xs font-medium text-green-600">
            ${lead.treatment_value.toLocaleString()}
          </span>
        )}
      </div>
    </div>
  )
}
