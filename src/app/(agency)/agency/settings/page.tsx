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
          <Settings className="h-5 w-5 text-violet-400" />
          <h1 className="text-2xl font-bold text-white">Agency Settings</h1>
        </div>
        <p className="text-slate-400 text-sm">
          Configure agency-level preferences and platform defaults.
        </p>
      </div>

      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <CardTitle className="text-white text-base">Platform Identity</CardTitle>
          <CardDescription className="text-slate-500 text-xs">
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
                <p className="text-xs text-slate-500">{item.label}</p>
                <p className="text-sm font-medium text-slate-200">{item.value}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
