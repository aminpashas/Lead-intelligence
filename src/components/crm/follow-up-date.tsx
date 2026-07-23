'use client'

/**
 * FollowUpDate — the follow-up row for the lead identity header.
 *
 * When the lead is on hold (`hold_until` in the future) it shows a prominent
 * "Following up · Aug 3" pill; otherwise a subtle "Set follow-up date" prompt so
 * the date is always reachable right by the name. Either state opens the hold
 * dialog (via HoldLead), which is the single write-path — a hold pauses ALL
 * outbound automation until the date, so "follow-up" and "hold" are one field.
 */
import { CalendarClock, Plus } from 'lucide-react'
import { HoldLead } from './hold-lead'
import type { Lead } from '@/types/database'

export function FollowUpDate({ lead }: { lead: Lead }) {
  const held = !!lead.hold_until && new Date(lead.hold_until).getTime() > Date.now()
  const when = held
    ? new Date(lead.hold_until as string).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      })
    : null

  const trigger = held ? (
    <button
      type="button"
      title={lead.hold_reason ?? undefined}
      className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-amber-100 px-2 py-0.5 text-[12px] font-medium text-amber-800 transition-colors hover:bg-amber-200"
    >
      <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.75} />
      Following up · {when}
    </button>
  ) : (
    <button
      type="button"
      className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-aurea-ink-3 transition-colors hover:text-aurea-ink"
    >
      <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
      Set follow-up date
    </button>
  )

  return <HoldLead lead={lead} trigger={trigger} />
}
