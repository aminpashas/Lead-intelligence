import { Plug, CheckCircle2, XCircle, AlertCircle } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

export const metadata = {
  title: 'Integrations | Agency | Lead Intelligence',
}

function IntegrationStatus({ configured }: { configured: boolean }) {
  if (configured) {
    return (
      <div className="flex items-center gap-1.5 text-aurea-primary">
        <CheckCircle2 className="h-4 w-4" />
        <span className="text-xs font-medium">Connected</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 text-aurea-rose">
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
    critical: 'bg-aurea-rose/10 text-aurea-rose border-aurea-rose/20',
    high: 'bg-aurea-amber/10 text-aurea-amber border-aurea-amber/20',
    medium: 'bg-aurea-surface-2 text-aurea-ink-2 border-aurea-border',
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Plug className="h-5 w-5 text-aurea-primary" />
          <h1 className="text-2xl font-bold text-aurea-ink">Integrations</h1>
        </div>
        <p className="text-aurea-ink-2 text-sm">
          All platform-level API keys and external service connections. Configure these in{' '}
          <code className="bg-aurea-surface-2 text-aurea-ink-2 px-1.5 py-0.5 rounded text-xs">.env.local</code>.
        </p>
      </div>

      <Card className="bg-aurea-amber/5 border-aurea-amber/20">
        <CardContent className="pt-5">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-aurea-amber shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-aurea-amber">Agency-Only</p>
              <p className="text-xs text-aurea-ink-2 mt-1">
                These integration keys are never exposed to practice users. They are managed
                server-side and visible only to agency admins.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {integrations.map((category) => (
        <div key={category.category}>
          <h2 className="aurea-eyebrow mb-3">
            {category.category}
          </h2>
          <div className="space-y-3">
            {category.items.map((integration) => (
              <Card
                key={integration.name}
                className="bg-aurea-surface border-aurea-border hover:border-aurea-border-strong transition-colors"
              >
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <CardTitle className="text-aurea-ink text-sm">{integration.name}</CardTitle>
                        <Badge
                          className={`text-[9px] h-4 px-1.5 border ${IMPACT_BADGE[integration.impact]}`}
                        >
                          {integration.impact}
                        </Badge>
                      </div>
                      <CardDescription className="text-aurea-ink-3 text-xs">
                        {integration.description}
                      </CardDescription>
                      <code className="mt-2 block text-[10px] text-aurea-ink-3 font-mono">
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
                          className="text-[10px] text-aurea-primary hover:text-aurea-primary/80 underline"
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
