import { SalesIntelligenceDashboard } from '@/components/crm/sales-intelligence-dashboard'

export default function SalesIntelligencePage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Sales Intelligence</h1>
        <p className="text-muted-foreground">
          Track which sales techniques the AI uses, their effectiveness, and how it adapts per lead
        </p>
      </div>

      <SalesIntelligenceDashboard />
    </div>
  )
}
