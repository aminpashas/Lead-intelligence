import { PauseCircle } from 'lucide-react'
import type { Lead } from '@/types/database'

/** "On hold until Aug 3" pill. Renders nothing when the lead is not on hold. */
export function HoldBadge({ lead }: { lead: Pick<Lead, 'hold_until'> }) {
  if (!lead.hold_until || new Date(lead.hold_until).getTime() <= Date.now()) return null
  const when = new Date(lead.hold_until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
      <PauseCircle className="h-3 w-3" strokeWidth={2} />
      On hold until {when}
    </span>
  )
}
