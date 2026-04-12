import Link from 'next/link'
import { Shield, ArrowRight, Lock } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'

export default function AiAuditPracticePage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-6">
      <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
        <Lock className="h-8 w-8 text-primary/60" />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          <h1 className="text-2xl font-bold">AI Audit</h1>
        </div>
        <p className="text-muted-foreground max-w-sm">
          AI Audit logs are managed at the agency level to maintain platform
          quality oversight and compliance.
        </p>
      </div>

      <Card className="max-w-sm w-full border-primary/20">
        <CardContent className="pt-5 space-y-4">
          <p className="text-sm text-muted-foreground">
            To view AI quality ratings, feedback logs, and audit history,
            please log in to the Agency Control Panel.
          </p>
          <Link
            href="/login"
            className="flex items-center justify-center gap-2 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Go to Agency Login <ArrowRight className="h-4 w-4" />
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}
