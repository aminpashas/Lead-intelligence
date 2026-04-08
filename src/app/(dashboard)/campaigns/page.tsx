import { createClient } from '@/lib/supabase/server'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Megaphone, Plus, Mail, MessageSquare } from 'lucide-react'
import { format } from 'date-fns'
import { CampaignBuilder } from '@/components/crm/campaign-builder'

const statusColors: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-700',
  active: 'bg-green-100 text-green-700',
  paused: 'bg-yellow-100 text-yellow-700',
  completed: 'bg-blue-100 text-blue-700',
  archived: 'bg-gray-50 text-gray-400',
}

export default async function CampaignsPage() {
  const supabase = await createClient()

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('organization_id')
    .single()

  if (!profile) return null

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('*')
    .eq('organization_id', profile.organization_id)
    .order('created_at', { ascending: false })

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Campaigns</h1>
          <p className="text-muted-foreground">
            SMS and email drip campaigns for lead nurturing
          </p>
        </div>
        <CampaignBuilder />
      </div>

      {(!campaigns || campaigns.length === 0) ? (
        <Card>
          <CardContent className="flex flex-col items-center py-12">
            <Megaphone className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="font-medium">No campaigns yet</p>
            <p className="text-sm text-muted-foreground mb-4">
              Create your first drip campaign to nurture leads automatically
            </p>
            <Button className="gap-2">
              <Plus className="h-4 w-4" />
              Create Campaign
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {campaigns.map((campaign) => (
            <Card key={campaign.id} className="hover:bg-accent/30 cursor-pointer transition-colors">
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {campaign.channel === 'sms' ? (
                      <MessageSquare className="h-5 w-5 text-muted-foreground" />
                    ) : campaign.channel === 'email' ? (
                      <Mail className="h-5 w-5 text-muted-foreground" />
                    ) : (
                      <Megaphone className="h-5 w-5 text-muted-foreground" />
                    )}
                    <div>
                      <p className="font-medium">{campaign.name}</p>
                      {campaign.description && (
                        <p className="text-sm text-muted-foreground">{campaign.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge className={statusColors[campaign.status]}>
                      {campaign.status}
                    </Badge>
                    <div className="text-right text-sm">
                      <p className="font-medium">{campaign.total_enrolled} enrolled</p>
                      <p className="text-xs text-muted-foreground">
                        {campaign.total_converted} converted
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
