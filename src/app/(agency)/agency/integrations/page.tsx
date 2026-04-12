import { Plug, CheckCircle2, XCircle, AlertCircle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export const metadata = {
  title: 'Integrations | Agency | Lead Intelligence',
}

function IntegrationStatus({ configured }: { configured: boolean }) {
  if (configured) {
    return (
      <div className="flex items-center gap-1.5 text-emerald-400">
        <CheckCircle2 className="h-4 w-4" />
        <span className="text-xs font-medium">Connected</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 text-red-400">
      <XCircle className="h-4 w-4" />
      <span className="text-xs font-medium">Not configured</span>
    </div>
  )
}

export default function AgencyIntegrationsPage() {
  const integrations = [
    {
      category: 'AI',
      items: [
        {
          name: 'Anthropic (Claude)',
          description: 'Powers all AI conversations, lead scoring, and response generation.',
          envKey: 'ANTHROPIC_API_KEY',
          configured: !!process.env.ANTHROPIC_API_KEY,
          docUrl: 'https://console.anthropic.com/api-keys',
          impact: 'critical',
        },
      ],
    },
    {
      category: 'Messaging',
      items: [
        {
          name: 'Twilio SMS',
          description: 'Outbound & inbound SMS for all lead communications.',
          envKey: 'TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_PHONE_NUMBER',
          configured: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
          docUrl: 'https://console.twilio.com/',
          impact: 'critical',
        },
        {
          name: 'Resend Email',
          description: 'Email campaigns, follow-up sequences, and transactional emails.',
          envKey: 'RESEND_API_KEY',
          configured: !!process.env.RESEND_API_KEY,
          docUrl: 'https://resend.com/api-keys',
          impact: 'high',
        },
      ],
    },
    {
      category: 'Infrastructure',
      items: [
        {
          name: 'Supabase',
          description: 'Database, real-time subscriptions, and authentication.',
          envKey: 'NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY',
          configured: !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
          docUrl: 'https://supabase.com/dashboard',
          impact: 'critical',
        },
        {
          name: 'Supabase Service Role',
          description: 'Required for webhooks, cron jobs, and bypassing RLS in admin tasks.',
          envKey: 'SUPABASE_SERVICE_ROLE_KEY',
          configured: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
          docUrl: 'https://supabase.com/dashboard/project/_/settings/api',
          impact: 'high',
        },
        {
          name: 'Webhook Signing Secret',
          description: 'HMAC signature verification for all incoming webhooks.',
          envKey: 'WEBHOOK_SECRET',
          configured: !!process.env.WEBHOOK_SECRET,
          docUrl: null,
          impact: 'critical',
        },
        {
          name: 'PII Encryption Key',
          description: 'AES-256 key used to encrypt sensitive patient data (HIPAA).',
          envKey: 'ENCRYPTION_KEY',
          configured: !!process.env.ENCRYPTION_KEY,
          docUrl: null,
          impact: 'critical',
        },
      ],
    },
  ]

  const IMPACT_BADGE: Record<string, string> = {
    critical: 'bg-red-500/10 text-red-400 border-red-500/20',
    high: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
    medium: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Plug className="h-5 w-5 text-violet-400" />
          <h1 className="text-2xl font-bold text-white">Integrations</h1>
        </div>
        <p className="text-slate-400 text-sm">
          All platform-level API keys and external service connections. Configure these in{' '}
          <code className="bg-slate-800 text-violet-300 px-1.5 py-0.5 rounded text-xs">.env.local</code>.
        </p>
      </div>

      <Card className="bg-amber-500/5 border-amber-500/20">
        <CardContent className="pt-5">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-300">Agency-Only</p>
              <p className="text-xs text-slate-400 mt-1">
                These integration keys are never exposed to practice users. They are managed
                server-side and visible only to agency admins.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {integrations.map((category) => (
        <div key={category.category}>
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-3">
            {category.category}
          </h2>
          <div className="space-y-3">
            {category.items.map((integration) => (
              <Card
                key={integration.name}
                className="bg-slate-900 border-slate-800 hover:border-slate-700 transition-colors"
              >
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <CardTitle className="text-white text-sm">{integration.name}</CardTitle>
                        <Badge
                          className={`text-[9px] h-4 px-1.5 border ${IMPACT_BADGE[integration.impact]}`}
                        >
                          {integration.impact}
                        </Badge>
                      </div>
                      <CardDescription className="text-slate-500 text-xs">
                        {integration.description}
                      </CardDescription>
                      <code className="mt-2 block text-[10px] text-slate-600 font-mono">
                        {integration.envKey}
                      </code>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <IntegrationStatus configured={integration.configured} />
                      {integration.docUrl && (
                        <a
                          href={integration.docUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-violet-400 hover:text-violet-300 underline"
                        >
                          Open Console →
                        </a>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
