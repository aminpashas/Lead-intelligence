'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Megaphone, Plus, Mail, MessageSquare, Play, Pause, Zap, Users,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { CampaignBuilder } from './campaign-builder'
import { CAMPAIGN_TEMPLATES } from '@/lib/campaigns/templates'
import type { Campaign } from '@/types/database'

const statusColors: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  active: 'bg-green-100 text-green-700',
  paused: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-blue-100 text-blue-700',
}

export function CampaignsList({ campaigns: initial }: { campaigns: Campaign[] }) {
  const [campaigns, setCampaigns] = useState(initial)
  const [deploying, setDeploying] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const router = useRouter()

  async function deployTemplate(templateId: string) {
    const template = CAMPAIGN_TEMPLATES.find((t) => t.id === templateId)
    if (!template) return

    setDeploying(templateId)
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: template.name,
          description: template.description,
          type: template.type,
          channel: template.channel,
          target_criteria: template.target_criteria,
          send_window: template.send_window,
          steps: template.steps,
        }),
      })

      if (!res.ok) throw new Error('Failed to create')
      toast.success(`"${template.name}" campaign created! Activate it to start sending.`)
      router.refresh()
    } catch {
      toast.error('Failed to create campaign')
    } finally {
      setDeploying(null)
    }
  }

  async function toggleCampaign(id: string, currentStatus: string) {
    setToggling(id)
    const action = currentStatus === 'active' ? 'pause' : 'activate'
    try {
      const res = await fetch(`/api/campaigns/${id}/${action}`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
      toast.success(action === 'activate' ? 'Campaign activated! Leads will be enrolled automatically.' : 'Campaign paused.')
      router.refresh()
    } catch {
      toast.error(`Failed to ${action} campaign`)
    } finally {
      setToggling(null)
    }
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Campaigns</h1>
          <p className="text-muted-foreground">Automated SMS and email sequences that nurture leads 24/7</p>
        </div>
        <CampaignBuilder />
      </div>

      {/* Quick-deploy templates */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-3">One-Click Templates</h2>
        <p className="text-sm text-muted-foreground mb-4">Deploy a proven campaign in seconds. Customize after.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {CAMPAIGN_TEMPLATES.map((template) => (
            <Card key={template.id} className="hover:border-primary/50 transition-colors">
              <CardContent className="pt-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    {template.channel === 'multi' ? <Zap className="h-5 w-5 text-amber-500" /> :
                     template.channel === 'sms' ? <MessageSquare className="h-5 w-5 text-blue-500" /> :
                     <Mail className="h-5 w-5 text-purple-500" />}
                    <Badge variant="secondary">{template.steps.length} steps</Badge>
                  </div>
                  <Badge variant="outline">{template.channel}</Badge>
                </div>
                <h3 className="font-semibold mb-1">{template.name}</h3>
                <p className="text-sm text-muted-foreground mb-4">{template.description}</p>
                <Button
                  size="sm"
                  className="w-full gap-1.5"
                  onClick={() => deployTemplate(template.id)}
                  disabled={deploying === template.id}
                >
                  {deploying === template.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Deploy Template
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Existing campaigns */}
      <h2 className="text-lg font-semibold mb-3">Your Campaigns</h2>
      {campaigns.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12">
            <Megaphone className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="font-medium">No campaigns yet</p>
            <p className="text-sm text-muted-foreground">Deploy a template above or build one from scratch</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {campaigns.map((campaign) => (
            <Card key={campaign.id}>
              <CardContent className="py-4 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {campaign.channel === 'sms' ? <MessageSquare className="h-5 w-5 text-muted-foreground" /> :
                   campaign.channel === 'email' ? <Mail className="h-5 w-5 text-muted-foreground" /> :
                   <Zap className="h-5 w-5 text-muted-foreground" />}
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-medium">{campaign.name}</p>
                      <Badge className={statusColors[campaign.status]}>{campaign.status}</Badge>
                    </div>
                    {campaign.description && (
                      <p className="text-sm text-muted-foreground mt-0.5">{campaign.description}</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="text-right text-sm">
                    <p className="font-medium flex items-center gap-1">
                      <Users className="h-3.5 w-3.5" /> {campaign.total_enrolled} enrolled
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {campaign.total_completed} completed &bull; {campaign.total_converted} converted
                    </p>
                  </div>

                  {campaign.status === 'draft' || campaign.status === 'paused' ? (
                    <Button
                      size="sm"
                      variant="default"
                      className="gap-1.5"
                      onClick={() => toggleCampaign(campaign.id, campaign.status)}
                      disabled={toggling === campaign.id}
                    >
                      {toggling === campaign.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                      Activate
                    </Button>
                  ) : campaign.status === 'active' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => toggleCampaign(campaign.id, campaign.status)}
                      disabled={toggling === campaign.id}
                    >
                      {toggling === campaign.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pause className="h-4 w-4" />}
                      Pause
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
