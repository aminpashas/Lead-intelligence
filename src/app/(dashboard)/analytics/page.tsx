import { AnalyticsDashboard } from '@/components/crm/analytics-charts'

export default function AnalyticsPage() {
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Analytics</h1>
        <p className="text-muted-foreground">
          Performance overview, lead trends, and campaign metrics
        </p>
      </div>
      <AnalyticsDashboard />
    </div>
  )
}
