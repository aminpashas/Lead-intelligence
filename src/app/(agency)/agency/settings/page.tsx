import { Settings } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'

export const metadata = {
  title: 'Agency Settings | Lead Intelligence',
}

export default function AgencySettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Settings className="h-5 w-5 text-aurea-primary" />
          <h1 className="text-2xl font-bold text-aurea-ink">Agency Settings</h1>
        </div>
        <p className="text-aurea-ink-2 text-sm">
          Configure agency-level preferences and platform defaults.
        </p>
      </div>

      <Card className="bg-aurea-surface border-aurea-border">
        <CardHeader>
          <CardTitle className="text-aurea-ink text-base">Platform Identity</CardTitle>
          <CardDescription className="text-aurea-ink-3 text-xs">
            How your agency appears on the platform.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {[
              { label: 'Platform Name', value: 'Lead Intelligence' },
              { label: 'Agency Version', value: '2.0.0' },
              { label: 'Deployment', value: 'Production' },
              { label: 'Architecture', value: 'Agency / Practice (Multi-Tenant)' },
            ].map((item) => (
              <div key={item.label} className="space-y-1">
                <p className="text-xs text-aurea-ink-3">{item.label}</p>
                <p className="text-sm font-medium text-aurea-ink-2">{item.value}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
