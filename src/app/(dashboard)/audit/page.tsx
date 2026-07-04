import { History } from 'lucide-react'
import { AuditTimeline } from '@/components/audit/AuditTimeline'

export const metadata = {
  title: 'Audit Trail | Lead Intelligence',
}

export default function AuditTrailPage() {
  return (
    <div className="space-y-6">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <History className="h-5 w-5 text-aurea-primary" strokeWidth={1.75} />
          <h1 className="text-2xl font-bold text-aurea-ink">Audit trail</h1>
        </div>
        <p className="text-sm text-aurea-ink-2">
          Every action taken in this workspace — by staff and by AI.
        </p>
      </div>

      <AuditTimeline query="limit=200" />
    </div>
  )
}
