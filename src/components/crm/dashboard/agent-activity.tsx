'use client'

/**
 * Agent activity — what the autopilot actually did, made visible.
 *
 * Server-rendered from lead_activities (AI-only types, see dashboard/page.tsx),
 * then live-refreshed when new AI activity lands (same postgres_changes pattern
 * as lead-timeline.tsx). If realtime isn't enabled for the table the subscription
 * simply never fires — the feed still works on navigation.
 */

import { useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import {
  Brain, Zap, HandMetal, MessageSquare, Mail, CreditCard, Activity, type LucideIcon,
} from 'lucide-react'

const activityMeta: Record<string, { icon: LucideIcon; verb: string }> = {
  ai_scored: { icon: Brain, verb: 'Scored' },
  ai_speed_to_lead: { icon: Zap, verb: 'First-touch reply' },
  escalated_to_human: { icon: HandMetal, verb: 'Escalated' },
  cross_channel_sms_sent: { icon: MessageSquare, verb: 'Texted' },
  cross_channel_email_sent: { icon: Mail, verb: 'Emailed' },
  financing_link_sent: { icon: CreditCard, verb: 'Sent financing link' },
}

export type AgentActivityItem = {
  id: string
  activity_type: string
  title: string | null
  created_at: string
  lead: { id: string; first_name: string | null; last_name: string | null } | null
}

export function AgentActivity({ activities, orgId }: { activities: AgentActivityItem[]; orgId: string }) {
  const router = useRouter()

  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`agent-activity-${orgId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'lead_activities', filter: `organization_id=eq.${orgId}` },
        () => router.refresh()
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [orgId, router])

  return (
    <section className="aurea-card px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-aurea-primary opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-aurea-primary" />
        </span>
        <h2 className="aurea-display text-[18px] leading-tight text-aurea-ink">Agent activity</h2>
      </div>

      {activities.length === 0 ? (
        <p className="py-6 text-center text-[13px] leading-relaxed text-aurea-ink-3">
          No AI actions yet today. Activity shows up here the moment the agent scores, texts, or books.
        </p>
      ) : (
        <div className="space-y-3.5 border-l border-aurea-border pl-3.5">
          {activities.map((act) => {
            const meta = activityMeta[act.activity_type] ?? { icon: Activity, verb: act.title || 'Activity' }
            const Icon = meta.icon
            const name = act.lead ? [act.lead.first_name, act.lead.last_name].filter(Boolean).join(' ') : null
            return (
              <div key={act.id} className="flex items-start gap-2.5">
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] leading-snug text-aurea-ink-2">
                    <span className="font-medium text-aurea-ink">{meta.verb}</span>
                    {name && (
                      <>
                        {' — '}
                        {act.lead ? (
                          <Link href={`/leads/${act.lead.id}`} className="underline-offset-2 hover:underline">
                            {name}
                          </Link>
                        ) : (
                          name
                        )}
                      </>
                    )}
                  </p>
                  <p className="font-mono text-[11px] text-aurea-ink-3">
                    {formatDistanceToNow(new Date(act.created_at), { addSuffix: true })}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
