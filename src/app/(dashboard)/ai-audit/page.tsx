import { AiAuditDashboard } from '@/components/crm/ai-audit-dashboard'

export default function AiAuditPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">AI Audit</h1>
        <p className="text-muted-foreground">
          Review AI conversations, rate quality, and monitor compliance across Setter and Closer agents
        </p>
      </div>
      <AiAuditDashboard />
    </div>
  )
}
