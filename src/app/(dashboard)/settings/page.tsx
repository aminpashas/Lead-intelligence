'use client'

import { useOrgStore } from '@/lib/store/use-org'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Copy, Check } from 'lucide-react'
import { useState } from 'react'

export default function SettingsPage() {
  const { organization } = useOrgStore()
  const [copied, setCopied] = useState<string | null>(null)

  const webhookUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/api/webhooks/form?org=${organization?.id}`
    : ''

  function copyToClipboard(text: string, key: string) {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground">
          Manage your practice settings and integrations
        </p>
      </div>

      <div className="space-y-6">
        {/* Organization */}
        <Card>
          <CardHeader>
            <CardTitle>Practice Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Practice Name</Label>
              <Input value={organization?.name || ''} readOnly />
            </div>
            <div className="space-y-2">
              <Label>Subscription</Label>
              <div>
                <Badge variant="secondary" className="capitalize">
                  {organization?.subscription_tier || 'trial'}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Webhook URLs */}
        <Card>
          <CardHeader>
            <CardTitle>Webhook Integration</CardTitle>
            <CardDescription>
              Use these URLs to connect your landing pages, Google Ads, and Meta Lead Ads
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Universal Form Webhook</Label>
              <div className="flex gap-2">
                <Input value={webhookUrl} readOnly className="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyToClipboard(webhookUrl, 'form')}
                >
                  {copied === 'form' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                POST JSON with: first_name, last_name, email, phone, source_type, utm_source, dental_condition
              </p>
            </div>

            <Separator />

            <div className="space-y-2">
              <Label>Twilio SMS Webhook</Label>
              <div className="flex gap-2">
                <Input
                  value={typeof window !== 'undefined' ? `${window.location.origin}/api/webhooks/twilio` : ''}
                  readOnly
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyToClipboard(
                    typeof window !== 'undefined' ? `${window.location.origin}/api/webhooks/twilio` : '',
                    'twilio'
                  )}
                >
                  {copied === 'twilio' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Set this as your Twilio phone number&apos;s SMS webhook URL
              </p>
            </div>

            <Separator />

            <div className="space-y-2">
              <Label>Resend Email Webhook</Label>
              <div className="flex gap-2">
                <Input
                  value={typeof window !== 'undefined' ? `${window.location.origin}/api/webhooks/resend` : ''}
                  readOnly
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyToClipboard(
                    typeof window !== 'undefined' ? `${window.location.origin}/api/webhooks/resend` : '',
                    'resend'
                  )}
                >
                  {copied === 'resend' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Set this in Resend dashboard &gt; Webhooks. Tracks email opens, clicks, bounces, and complaints.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Booking Link */}
        <Card>
          <CardHeader>
            <CardTitle>Online Booking</CardTitle>
            <CardDescription>
              Share this link with leads so they can self-book consultations
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Public Booking Page</Label>
              <div className="flex gap-2">
                <Input
                  value={typeof window !== 'undefined' ? `${window.location.origin}/book/${organization?.id}` : ''}
                  readOnly
                  className="font-mono text-xs"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copyToClipboard(
                    typeof window !== 'undefined' ? `${window.location.origin}/book/${organization?.id}` : '',
                    'booking'
                  )}
                >
                  {copied === 'booking' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Leads can book directly from this page. Use <code className="bg-muted px-1 rounded">{'{{booking_link}}'}</code> in campaign templates.
              </p>
            </div>
            <Separator />
            <p className="text-xs text-muted-foreground">
              To configure availability (office hours, slot duration, blocked dates), update the <code className="bg-muted px-1 rounded">booking_settings</code> table in your Supabase dashboard. Default: Mon-Fri 9am-5pm, 60-minute slots, 15-minute buffer.
            </p>
          </CardContent>
        </Card>

        {/* Financing Lenders section temporarily removed pending live integrations */}

        {/* API Keys status */}
        <Card>
          <CardHeader>
            <CardTitle>Integrations Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { name: 'Supabase', env: 'NEXT_PUBLIC_SUPABASE_URL' },
              { name: 'Anthropic AI', env: 'ANTHROPIC_API_KEY' },
              { name: 'Twilio SMS', env: 'TWILIO_ACCOUNT_SID' },
              { name: 'Resend Email', env: 'RESEND_API_KEY' },
            ].map((integration) => (
              <div key={integration.name} className="flex items-center justify-between">
                <span className="text-sm">{integration.name}</span>
                <Badge variant="outline" className="text-xs">
                  Configure in .env.local
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
