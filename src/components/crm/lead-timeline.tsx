'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { Card, CardContent } from '@/components/ui/card'
import { LeadMessaging } from './lead-messaging'
import { LogCallDialog } from './log-call-dialog'
import { MessageSquare, Mail, Phone, StickyNote, GitBranch } from 'lucide-react'
import type { Lead } from '@/types/database'
import type { TimelineEntry } from '@/lib/timeline/types'

const CHANNEL_ICON = {
  sms: MessageSquare,
  whatsapp: MessageSquare,
  web_chat: MessageSquare,
  email: Mail,
  voice: Phone,
} as const

function labelFor(entry: TimelineEntry): string {
  if (entry.kind === 'message') return entry.channel === 'email' ? 'Email' : 'SMS'
  if (entry.kind === 'call') return `Call · ${entry.direction}${entry.outcome ? ` · ${entry.outcome.replace(/_/g, ' ')}` : ''}`
  if (entry.kind === 'note') return 'Note'
  return 'Stage change'
}

function IconFor({ entry }: { entry: TimelineEntry }) {
  if (entry.kind === 'message') {
    const Icon = CHANNEL_ICON[entry.channel] ?? MessageSquare
    return <Icon className="h-4 w-4" strokeWidth={1.75} />
  }
  if (entry.kind === 'call') return <Phone className="h-4 w-4" strokeWidth={1.75} />
  if (entry.kind === 'note') return <StickyNote className="h-4 w-4" strokeWidth={1.75} />
  return <GitBranch className="h-4 w-4" strokeWidth={1.75} />
}

export function LeadTimeline({ lead, entries }: { lead: Lead; entries: TimelineEntry[] }) {
  const router = useRouter()

  // Live-refresh when a new message arrives for this lead.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`lead-timeline-${lead.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `lead_id=eq.${lead.id}` },
        () => router.refresh()
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [lead.id, router])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <LeadMessaging lead={lead} />
        <LogCallDialog leadId={lead.id} />
      </div>

      {entries.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-aurea-ink-3">
            No calls, texts, or emails yet. Use the actions above to start the conversation.
          </CardContent>
        </Card>
      ) : (
        <ol className="space-y-3">
          {entries.map((entry) => {
            const outbound = (entry.kind === 'message' || entry.kind === 'call') && entry.direction === 'outbound'
            return (
              <li key={`${entry.kind}-${entry.id}`} className={outbound ? 'flex justify-end' : 'flex justify-start'}>
                <div className={`max-w-[80%] rounded-lg border border-aurea-border px-3 py-2 ${outbound ? 'bg-aurea-surface-2' : 'bg-aurea-surface'}`}>
                  <div className="mb-1 flex items-center gap-1.5 text-xs text-aurea-ink-3">
                    <IconFor entry={entry} />
                    <span>{labelFor(entry)}</span>
                    <span>·</span>
                    <span>{formatDistanceToNow(new Date(entry.at), { addSuffix: true })}</span>
                    {entry.kind === 'message' && entry.aiGenerated && <span className="rounded bg-aurea-border/40 px-1">AI</span>}
                  </div>
                  {entry.kind === 'message' && (
                    <>
                      {entry.subject && <p className="text-sm font-medium text-aurea-ink">{entry.subject}</p>}
                      <p className="whitespace-pre-wrap text-sm text-aurea-ink-2">{entry.body}</p>
                    </>
                  )}
                  {entry.kind === 'call' && (
                    <p className="text-sm text-aurea-ink-2">
                      {entry.durationSeconds > 0 && <span>{Math.round(entry.durationSeconds / 60)} min. </span>}
                      {entry.notes ?? entry.transcriptSummary ?? 'No notes.'}
                    </p>
                  )}
                  {(entry.kind === 'note' || entry.kind === 'stage_change') && (
                    <p className="whitespace-pre-wrap text-sm text-aurea-ink-2">{entry.body || entry.title}</p>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
