'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Send, CheckCircle, MessageSquare, Mail, ArrowLeft,
  Users, TrendingUp, Eye, Reply, DollarSign, BarChart3,
  Sparkles, Target, ArrowUpRight, ArrowDownRight, Minus,
  ListFilter, Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { Campaign } from '@/types/database'

interface CampaignPerformanceProps {
  campaigns: (Campaign & {
    smart_list_name?: string
    smart_list_color?: string
  })[]
  onBack?: () => void
}

type KPI = {
  label: string
  value: string | number
  change?: number
  icon: React.ElementType
  color: string
}

export function CampaignPerformance({ campaigns, onBack }: CampaignPerformanceProps) {
  // Aggregate KPIs across all campaigns
  const totals = campaigns.reduce(
    (acc, c) => ({
      enrolled: acc.enrolled + (c.total_enrolled || 0),
      completed: acc.completed + (c.total_completed || 0),
      converted: acc.converted + (c.total_converted || 0),
      replied: acc.replied + ((c as any).total_replied || 0),
      opened: acc.opened + ((c as any).total_opened || 0),
      unsubscribed: acc.unsubscribed + (c.total_unsubscribed || 0),
      revenue: acc.revenue + ((c as any).revenue_attributed || 0),
    }),
    { enrolled: 0, completed: 0, converted: 0, replied: 0, opened: 0, unsubscribed: 0, revenue: 0 }
  )

  const overallReplyRate = totals.enrolled > 0
    ? ((totals.replied / totals.enrolled) * 100).toFixed(1)
    : '0.0'
  const overallConversionRate = totals.enrolled > 0
    ? ((totals.converted / totals.enrolled) * 100).toFixed(1)
    : '0.0'

  const kpis: KPI[] = [
    { label: 'Total Enrolled', value: totals.enrolled, icon: Users, color: 'text-blue-500' },
    { label: 'Messages Replied', value: totals.replied, icon: Reply, color: 'text-green-500' },
    { label: 'Reply Rate', value: `${overallReplyRate}%`, icon: TrendingUp, color: 'text-emerald-500' },
    { label: 'Conversions', value: totals.converted, icon: Target, color: 'text-purple-500' },
    { label: 'Conversion Rate', value: `${overallConversionRate}%`, icon: BarChart3, color: 'text-amber-500' },
    { label: 'Revenue', value: `$${totals.revenue.toLocaleString()}`, icon: DollarSign, color: 'text-green-600' },
  ]

  // Sort campaigns by conversion rate (best performing first)
  const ranked = [...campaigns].sort((a, b) => {
    const aRate = a.total_enrolled > 0 ? (a.total_converted / a.total_enrolled) : 0
    const bRate = b.total_enrolled > 0 ? (b.total_converted / b.total_enrolled) : 0
    return bRate - aRate
  })

  // Smart List performance
  const smartListPerformance = campaigns
    .filter((c) => (c as any).smart_list_name)
    .reduce((acc, c) => {
      const name = (c as any).smart_list_name
      if (!acc[name]) {
        acc[name] = {
          name,
          color: (c as any).smart_list_color || '#6366F1',
          campaigns: 0,
          enrolled: 0,
          converted: 0,
          replied: 0,
          revenue: 0,
        }
      }
      acc[name].campaigns++
      acc[name].enrolled += c.total_enrolled || 0
      acc[name].converted += c.total_converted || 0
      acc[name].replied += (c as any).total_replied || 0
      acc[name].revenue += (c as any).revenue_attributed || 0
      return acc
    }, {} as Record<string, any>)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        )}
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-primary" />
            Campaign Performance
          </h1>
          <p className="text-sm text-muted-foreground">
            Track what works and what doesn&apos;t across all your campaigns
          </p>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <kpi.icon className={cn('h-4 w-4', kpi.color)} />
                <span className="text-xs text-muted-foreground">{kpi.label}</span>
              </div>
              <p className="text-xl font-bold">{kpi.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Campaign Rankings Table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Campaign Rankings
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {ranked.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">
              No campaigns to analyze yet
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">#</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Smart List</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Enrolled</TableHead>
                  <TableHead className="text-right">Replied</TableHead>
                  <TableHead className="text-right">Reply Rate</TableHead>
                  <TableHead className="text-right">Converted</TableHead>
                  <TableHead className="text-right">Conv. Rate</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ranked.map((campaign, index) => {
                  const replyRate = campaign.total_enrolled > 0
                    ? (((campaign as any).total_replied || 0) / campaign.total_enrolled * 100)
                    : 0
                  const convRate = campaign.total_enrolled > 0
                    ? (campaign.total_converted / campaign.total_enrolled * 100)
                    : 0

                  return (
                    <TableRow key={campaign.id}>
                      <TableCell>
                        <span className={cn(
                          'inline-flex items-center justify-center h-6 w-6 rounded-full text-xs font-bold',
                          index === 0 && 'bg-amber-100 text-amber-700',
                          index === 1 && 'bg-gray-100 text-gray-700',
                          index === 2 && 'bg-orange-100 text-orange-700',
                          index > 2 && 'text-muted-foreground'
                        )}>
                          {index + 1}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="font-medium text-sm">{campaign.name}</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <Badge variant="outline" className="text-[10px] px-1.5">
                              {campaign.channel === 'sms' ? (
                                <><MessageSquare className="h-2.5 w-2.5 mr-0.5" /> SMS</>
                              ) : campaign.channel === 'email' ? (
                                <><Mail className="h-2.5 w-2.5 mr-0.5" /> Email</>
                              ) : (
                                <><Sparkles className="h-2.5 w-2.5 mr-0.5" /> Multi</>
                              )}
                            </Badge>
                            <Badge variant="outline" className="text-[10px] px-1.5">{campaign.type}</Badge>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        {(campaign as any).smart_list_name ? (
                          <div className="flex items-center gap-1.5">
                            <ListFilter
                              className="h-3 w-3"
                              style={{ color: (campaign as any).smart_list_color }}
                            />
                            <span className="text-xs">{(campaign as any).smart_list_name}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">Manual</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={campaign.status === 'active' ? 'default' : 'secondary'}
                          className="text-xs"
                        >
                          {campaign.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-medium">{campaign.total_enrolled}</TableCell>
                      <TableCell className="text-right">{(campaign as any).total_replied || 0}</TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant={replyRate > 15 ? 'default' : replyRate > 5 ? 'secondary' : 'outline'}
                          className="text-xs"
                        >
                          {replyRate.toFixed(1)}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{campaign.total_converted}</TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant={convRate > 10 ? 'default' : convRate > 3 ? 'secondary' : 'outline'}
                          className="text-xs"
                        >
                          {convRate.toFixed(1)}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-medium text-green-600">
                        ${((campaign as any).revenue_attributed || 0).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Smart List Performance */}
      {Object.keys(smartListPerformance).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              <ListFilter className="h-4 w-4" />
              Performance by Smart List
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.values(smartListPerformance).map((sl: any) => {
                const convRate = sl.enrolled > 0 ? ((sl.converted / sl.enrolled) * 100).toFixed(1) : '0.0'
                const replyRate = sl.enrolled > 0 ? ((sl.replied / sl.enrolled) * 100).toFixed(1) : '0.0'
                return (
                  <Card key={sl.name} className="border">
                    <CardContent className="pt-4">
                      <div className="flex items-center gap-2 mb-3">
                        <div
                          className="h-8 w-8 rounded-lg flex items-center justify-center"
                          style={{ backgroundColor: sl.color + '15' }}
                        >
                          <ListFilter className="h-4 w-4" style={{ color: sl.color }} />
                        </div>
                        <div>
                          <p className="font-medium text-sm">{sl.name}</p>
                          <p className="text-xs text-muted-foreground">{sl.campaigns} campaign{sl.campaigns > 1 ? 's' : ''}</p>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div>
                          <p className="text-muted-foreground text-xs">Enrolled</p>
                          <p className="font-medium">{sl.enrolled}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs">Reply Rate</p>
                          <p className="font-medium">{replyRate}%</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs">Conv. Rate</p>
                          <p className="font-medium">{convRate}%</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs">Revenue</p>
                          <p className="font-medium text-green-600">${sl.revenue.toLocaleString()}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Strategy Insights */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" />
            Strategy Insights
          </CardTitle>
        </CardHeader>
        <CardContent>
          {campaigns.length < 2 ? (
            <p className="text-sm text-muted-foreground">
              Create and run at least 2 campaigns to see comparative strategy insights.
            </p>
          ) : (
            <div className="space-y-3">
              {/* Best performing campaign */}
              {ranked[0] && ranked[0].total_enrolled > 0 && (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-green-50 dark:bg-green-950/20">
                  <ArrowUpRight className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-green-800 dark:text-green-400">
                      Top Performer: &quot;{ranked[0].name}&quot;
                    </p>
                    <p className="text-xs text-green-700 dark:text-green-500 mt-0.5">
                      {ranked[0].total_enrolled} enrolled,{' '}
                      {(ranked[0].total_enrolled > 0
                        ? (ranked[0].total_converted / ranked[0].total_enrolled * 100).toFixed(1)
                        : 0)}% conversion rate.
                      {ranked[0].channel === 'sms' ? ' SMS campaigns tend to get faster replies.' : ''}
                    </p>
                  </div>
                </div>
              )}

              {/* Worst performing campaign */}
              {ranked.length > 1 && ranked[ranked.length - 1]?.total_enrolled > 0 && (
                <div className="flex items-start gap-3 p-3 rounded-lg bg-red-50 dark:bg-red-950/20">
                  <ArrowDownRight className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-red-800 dark:text-red-400">
                      Needs Improvement: &quot;{ranked[ranked.length - 1].name}&quot;
                    </p>
                    <p className="text-xs text-red-700 dark:text-red-500 mt-0.5">
                      Consider revising message copy, timing, or targeting criteria.
                    </p>
                  </div>
                </div>
              )}

              {/* General Tips */}
              <div className="flex items-start gap-3 p-3 rounded-lg bg-blue-50 dark:bg-blue-950/20">
                <Sparkles className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-blue-800 dark:text-blue-400">
                    Strategy Tip
                  </p>
                  <p className="text-xs text-blue-700 dark:text-blue-500 mt-0.5">
                    Create Smart Lists for different lead segments (e.g., &quot;Hot + Financing Interested&quot;
                    vs &quot;Cold + No Show&quot;) and run A/B campaigns to find the best messaging for each group.
                  </p>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
