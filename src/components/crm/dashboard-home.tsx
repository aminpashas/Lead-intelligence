'use client'

import Link from 'next/link'
import { formatDistanceToNow, format } from 'date-fns'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Users, Flame, TrendingUp, DollarSign, Calendar, MessageSquare,
  ArrowRight, Clock, Phone, Mail, Zap, Brain, Bell,
  CheckCircle2, AlertCircle, UserPlus, Megaphone,
} from 'lucide-react'

const qualColors: Record<string, string> = {
  hot: 'bg-red-500/10 text-red-700 border-red-200',
  warm: 'bg-orange-500/10 text-orange-700 border-orange-200',
  cold: 'bg-blue-500/10 text-blue-700 border-blue-200',
  unqualified: 'bg-gray-100 text-gray-600 border-gray-200',
  unscored: 'bg-gray-50 text-gray-400 border-gray-100',
}

const activityIcons: Record<string, React.ReactNode> = {
  lead_created: <UserPlus className="h-3.5 w-3.5 text-green-600" />,
  status_changed: <TrendingUp className="h-3.5 w-3.5 text-blue-600" />,
  message_sent: <MessageSquare className="h-3.5 w-3.5 text-purple-600" />,
  message_received: <MessageSquare className="h-3.5 w-3.5 text-green-600" />,
  appointment_scheduled: <Calendar className="h-3.5 w-3.5 text-orange-600" />,
  ai_scored: <Brain className="h-3.5 w-3.5 text-indigo-600" />,
  disqualified: <AlertCircle className="h-3.5 w-3.5 text-red-600" />,
  campaign_enrolled: <Megaphone className="h-3.5 w-3.5 text-amber-600" />,
}

function formatCurrency(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`
  return `$${n}`
}

type DashboardProps = {
  userName: string
  hotLeads: any[]
  todayAppointments: any[]
  recentLeads: any[]
  unreadConversations: any[]
  activeCampaigns: any[]
  recentActivities: any[]
  kpis: {
    totalLeads: number
    hotLeads: number
    converted: number
    pipelineValue: number
    weekLeads: number
    todayAppointments: number
    unreadMessages: number
  }
}

export function DashboardHome({
  userName,
  hotLeads,
  todayAppointments,
  recentLeads,
  unreadConversations,
  activeCampaigns,
  recentActivities,
  kpis,
}: DashboardProps) {
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <div className="space-y-6 animate-in fade-in-0 duration-500">
      {/* Greeting + Quick Stats */}
      <div>
        <h1 className="text-2xl font-bold">{greeting}, {userName}</h1>
        <p className="text-muted-foreground">Here&apos;s what&apos;s happening with your leads today.</p>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        <MiniKPI icon={Users} label="Total Leads" value={kpis.totalLeads} />
        <MiniKPI icon={Flame} label="Hot Leads" value={kpis.hotLeads} color="text-red-500" />
        <MiniKPI icon={TrendingUp} label="This Week" value={`+${kpis.weekLeads}`} color="text-green-600" />
        <MiniKPI icon={CheckCircle2} label="Converted" value={kpis.converted} color="text-purple-600" />
        <MiniKPI icon={DollarSign} label="Pipeline" value={formatCurrency(kpis.pipelineValue)} color="text-emerald-600" />
        <MiniKPI icon={Calendar} label="Today Appts" value={kpis.todayAppointments} color="text-orange-500" />
        <MiniKPI icon={Bell} label="Unread" value={kpis.unreadMessages} color={kpis.unreadMessages > 0 ? 'text-red-500' : 'text-gray-400'} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column — Priority Items */}
        <div className="lg:col-span-2 space-y-6">
          {/* Unread Messages */}
          {unreadConversations.length > 0 && (
            <Card className="border-red-200 bg-red-50/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Bell className="h-4 w-4 text-red-500" />
                  Unread Messages ({kpis.unreadMessages})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {unreadConversations.map((convo: any) => (
                    <Link key={convo.id} href={`/conversations/${convo.id}`}>
                      <div className="flex items-center justify-between p-2 rounded-lg hover:bg-white/80 transition-colors">
                        <div className="flex items-center gap-3">
                          <Badge variant="destructive" className="text-xs h-5 w-5 p-0 flex items-center justify-center">
                            {convo.unread_count}
                          </Badge>
                          <div>
                            <p className="text-sm font-medium">
                              {convo.lead?.first_name} {convo.lead?.last_name}
                            </p>
                            <p className="text-xs text-muted-foreground truncate max-w-xs">
                              {convo.last_message_preview}
                            </p>
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {convo.last_message_at
                            ? formatDistanceToNow(new Date(convo.last_message_at), { addSuffix: true })
                            : ''}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
                <Link href="/conversations">
                  <Button variant="ghost" size="sm" className="mt-2 w-full gap-1">
                    View all conversations <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

          {/* Hot Leads */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Flame className="h-4 w-4 text-red-500" />
                  Hot Leads — Priority Follow-up
                </CardTitle>
                <Link href="/leads?qualification=hot">
                  <Button variant="ghost" size="sm" className="gap-1 text-xs">
                    View all <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {hotLeads.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No hot leads right now. Keep nurturing!</p>
              ) : (
                <div className="space-y-2">
                  {hotLeads.slice(0, 6).map((lead: any) => {
                    const needsAction = !lead.last_responded_at && lead.last_contacted_at
                    const neverContacted = !lead.last_contacted_at
                    return (
                      <Link key={lead.id} href={`/leads/${lead.id}`}>
                        <div className="flex items-center justify-between p-2 rounded-lg hover:bg-accent/50 transition-colors">
                          <div className="flex items-center gap-3">
                            <div className="h-8 w-8 rounded-full bg-red-100 flex items-center justify-center text-xs font-bold text-red-700">
                              {lead.ai_score}
                            </div>
                            <div>
                              <p className="text-sm font-medium">
                                {lead.first_name} {lead.last_name}
                              </p>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span className="capitalize">{lead.status.replace(/_/g, ' ')}</span>
                                {lead.phone && <Phone className="h-3 w-3" />}
                                {lead.email && <Mail className="h-3 w-3" />}
                              </div>
                            </div>
                          </div>
                          <div className="text-right">
                            {neverContacted && (
                              <Badge variant="destructive" className="text-xs">New — Contact Now</Badge>
                            )}
                            {needsAction && (
                              <Badge variant="outline" className="text-xs text-amber-700 border-amber-300">
                                <Clock className="h-3 w-3 mr-1" />
                                Awaiting reply
                              </Badge>
                            )}
                            {lead.last_responded_at && (
                              <span className="text-xs text-muted-foreground">
                                Replied {formatDistanceToNow(new Date(lead.last_responded_at), { addSuffix: true })}
                              </span>
                            )}
                          </div>
                        </div>
                      </Link>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Today's Appointments */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-orange-500" />
                  Today&apos;s Appointments ({todayAppointments.length})
                </CardTitle>
                <Link href="/appointments">
                  <Button variant="ghost" size="sm" className="gap-1 text-xs">
                    View all <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {todayAppointments.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No appointments today.</p>
              ) : (
                <div className="space-y-2">
                  {todayAppointments.map((apt: any) => (
                    <div key={apt.id} className="flex items-center justify-between p-2 rounded-lg bg-orange-50/50">
                      <div className="flex items-center gap-3">
                        <div className="text-center leading-tight">
                          <p className="text-lg font-bold text-orange-700">
                            {format(new Date(apt.scheduled_at), 'h:mm')}
                          </p>
                          <p className="text-xs text-orange-600">
                            {format(new Date(apt.scheduled_at), 'a')}
                          </p>
                        </div>
                        <div>
                          <p className="text-sm font-medium">
                            {apt.lead?.first_name} {apt.lead?.last_name}
                          </p>
                          <p className="text-xs text-muted-foreground capitalize">{apt.type}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={apt.status === 'confirmed' ? 'default' : 'secondary'} className="text-xs">
                          {apt.status}
                        </Badge>
                        {apt.lead?.phone && (
                          <a href={`tel:${apt.lead.phone}`}>
                            <Button variant="outline" size="icon" className="h-7 w-7">
                              <Phone className="h-3 w-3" />
                            </Button>
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent Leads */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <UserPlus className="h-4 w-4 text-green-600" />
                  New Leads (Last 48h)
                </CardTitle>
                <Link href="/leads">
                  <Button variant="ghost" size="sm" className="gap-1 text-xs">
                    View all <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {recentLeads.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No new leads in the last 48 hours.</p>
              ) : (
                <div className="space-y-2">
                  {recentLeads.map((lead: any) => (
                    <Link key={lead.id} href={`/leads/${lead.id}`}>
                      <div className="flex items-center justify-between p-2 rounded-lg hover:bg-accent/50 transition-colors">
                        <div className="flex items-center gap-3">
                          <Badge className={`text-xs ${qualColors[lead.ai_qualification]}`}>
                            {lead.ai_score}
                          </Badge>
                          <div>
                            <p className="text-sm font-medium">
                              {lead.first_name} {lead.last_name}
                            </p>
                            <p className="text-xs text-muted-foreground capitalize">
                              {lead.source_type?.replace(/_/g, ' ') || 'unknown'} &middot; {lead.status.replace(/_/g, ' ')}
                            </p>
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column — Campaigns + Activity Feed */}
        <div className="space-y-6">
          {/* Active Campaigns */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Megaphone className="h-4 w-4 text-amber-500" />
                  Active Campaigns
                </CardTitle>
                <Link href="/campaigns">
                  <Button variant="ghost" size="sm" className="gap-1 text-xs">
                    Manage <ArrowRight className="h-3 w-3" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent>
              {activeCampaigns.length === 0 ? (
                <div className="text-center py-4">
                  <p className="text-sm text-muted-foreground mb-2">No active campaigns</p>
                  <Link href="/campaigns">
                    <Button variant="outline" size="sm" className="gap-1.5">
                      <Zap className="h-3.5 w-3.5" /> Deploy a Campaign
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="space-y-3">
                  {activeCampaigns.map((c: any) => (
                    <div key={c.id} className="p-2.5 rounded-lg border">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-sm font-medium">{c.name}</p>
                        <Badge variant="outline" className="text-xs">{c.channel}</Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span>{c.total_enrolled} enrolled</span>
                        <span>{c.total_converted} converted</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Activity Feed */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {recentActivities.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">No recent activity.</p>
                ) : (
                  recentActivities.map((act: any) => (
                    <div key={act.id} className="flex items-start gap-2.5">
                      <div className="mt-0.5 shrink-0">
                        {activityIcons[act.activity_type] || <CheckCircle2 className="h-3.5 w-3.5 text-gray-400" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs">
                          <span className="font-medium">
                            {act.lead?.first_name} {act.lead?.last_name}
                          </span>
                          {' '}&mdash; {act.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(act.created_at), { addSuffix: true })}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          {/* Quick Actions */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Link href="/leads" className="block">
                <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                  <Users className="h-3.5 w-3.5" /> View All Leads
                </Button>
              </Link>
              <Link href="/pipeline" className="block">
                <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                  <TrendingUp className="h-3.5 w-3.5" /> Pipeline Board
                </Button>
              </Link>
              <Link href="/campaigns" className="block">
                <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                  <Megaphone className="h-3.5 w-3.5" /> Deploy Campaign
                </Button>
              </Link>
              <Link href="/analytics" className="block">
                <Button variant="outline" size="sm" className="w-full justify-start gap-2">
                  <Brain className="h-3.5 w-3.5" /> View Analytics
                </Button>
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function MiniKPI({
  icon: Icon,
  label,
  value,
  color = 'text-foreground',
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string | number
  color?: string
}) {
  return (
    <Card className="transition-all duration-200 hover:shadow-md hover:-translate-y-0.5">
      <CardContent className="pt-3 pb-2 px-3">
        <div className="flex items-center gap-1.5 mb-0.5">
          <Icon className={`h-3.5 w-3.5 ${color}`} />
          <span className="text-[11px] text-muted-foreground">{label}</span>
        </div>
        <p className={`text-xl font-bold ${color}`}>{value}</p>
      </CardContent>
    </Card>
  )
}
