'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
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
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  ArrowLeft, Users, Megaphone, Brain, Pencil, ChevronLeft,
  ChevronRight, Loader2, RefreshCw, Tags as TagsIcon, MessageSquare, Mail,
} from 'lucide-react'
import { toast } from 'sonner'
import { TagBadgeList } from './tag-badge'
import type { Lead, PipelineStage, SmartList, Tag } from '@/types/database'

const qualificationColors: Record<string, string> = {
  hot: 'bg-red-100 text-red-800',
  warm: 'bg-orange-100 text-orange-800',
  cold: 'bg-blue-100 text-blue-800',
  unqualified: 'bg-gray-100 text-gray-600',
  unscored: 'bg-gray-50 text-gray-400',
}

interface SmartListDetailProps {
  smartList: SmartList
  onEdit: () => void
  onBack: () => void
}

export function SmartListDetail({ smartList, onEdit, onBack }: SmartListDetailProps) {
  const [leads, setLeads] = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [totalPages, setTotalPages] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [leadTags, setLeadTags] = useState<Record<string, Tag[]>>({})
  const router = useRouter()
  const perPage = 50

  useEffect(() => {
    fetchLeads()
  }, [smartList.id, page])

  async function fetchLeads() {
    setLoading(true)
    try {
      const res = await fetch(`/api/smart-lists/${smartList.id}/leads?page=${page}&per_page=${perPage}`)
      if (res.ok) {
        const data = await res.json()
        setLeads(data.leads)
        setTotal(data.pagination.total)
        setTotalPages(data.pagination.total_pages)
      } else {
        toast.error('Failed to load leads')
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleRefresh() {
    setRefreshing(true)
    await fetchLeads()
    setRefreshing(false)
    toast.success('Smart List refreshed')
  }

  // Summarize criteria for display
  const criteriaLabels: string[] = []
  const c = smartList.criteria
  if (c.tags?.ids?.length) criteriaLabels.push(`${c.tags.ids.length} tag${c.tags.ids.length > 1 ? 's' : ''} (${c.tags.operator?.toUpperCase()})`)
  if (c.statuses?.length) criteriaLabels.push(`${c.statuses.length} statuses`)
  if (c.ai_qualifications?.length) criteriaLabels.push(c.ai_qualifications.join(', '))
  if (c.score_min || c.score_max) criteriaLabels.push(`Score: ${c.score_min || 0}–${c.score_max || 100}`)
  if (c.source_types?.length) criteriaLabels.push(`${c.source_types.length} sources`)
  if (c.has_phone) criteriaLabels.push('Has phone')
  if (c.has_email) criteriaLabels.push('Has email')
  if (c.sms_consent) criteriaLabels.push('SMS consent')

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div
          className="h-10 w-10 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: smartList.color + '20' }}
        >
          <Users className="h-5 w-5" style={{ color: smartList.color }} />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-bold">{smartList.name}</h1>
          {smartList.description && (
            <p className="text-sm text-muted-foreground">{smartList.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="gap-1.5">
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit} className="gap-1.5">
            <Pencil className="h-4 w-4" />
            Edit
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => router.push(`/mass-sms?smart_list_id=${smartList.id}`)}
          >
            <MessageSquare className="h-4 w-4" />
            Mass SMS
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => router.push(`/mass-email?smart_list_id=${smartList.id}`)}
          >
            <Mail className="h-4 w-4" />
            Mass Email
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => router.push(`/campaigns?smart_list_id=${smartList.id}`)}
          >
            <Megaphone className="h-4 w-4" />
            Launch Campaign
          </Button>
        </div>
      </div>

      {/* Stats & Criteria */}
      <div className="grid grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 text-center">
            <p className="text-2xl font-bold">{total.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">Matching Leads</p>
          </CardContent>
        </Card>
        <Card className="col-span-3">
          <CardContent className="pt-4">
            <p className="text-xs font-medium text-muted-foreground mb-2">Active Filters</p>
            <div className="flex flex-wrap gap-1.5">
              {criteriaLabels.length > 0 ? criteriaLabels.map((label, i) => (
                <Badge key={i} variant="secondary" className="text-xs capitalize">
                  {label}
                </Badge>
              )) : (
                <span className="text-xs text-muted-foreground">No filters set — showing all leads</span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Leads Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : leads.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16">
            <Users className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="font-medium">No matching leads</p>
            <p className="text-sm text-muted-foreground">
              Adjust your filters to match more leads
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lead</TableHead>
                    <TableHead>Engagement</TableHead>
                    <TableHead>Stage</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leads.map((lead) => {
                    const initials = `${lead.first_name?.[0] || ''}${lead.last_name?.[0] || ''}`.toUpperCase()
                    return (
                      <TableRow
                        key={lead.id}
                        className="cursor-pointer"
                        onClick={() => router.push(`/leads/${lead.id}`)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="h-8 w-8">
                              <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium text-sm">
                                {lead.first_name} {lead.last_name}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {lead.email || lead.phone}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge className={qualificationColors[lead.ai_qualification]}>
                            <Brain className="h-3 w-3 mr-1" />
                            {lead.ai_score}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {lead.pipeline_stage && (
                            <div className="flex items-center gap-1.5">
                              <div
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: lead.pipeline_stage.color }}
                              />
                              <span className="text-sm">{lead.pipeline_stage.name}</span>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs capitalize">
                            {lead.status.replace(/_/g, ' ')}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground capitalize">
                            {lead.source_type?.replace(/_/g, ' ') || '—'}
                          </span>
                        </TableCell>
                        <TableCell>
                          {lead.treatment_value ? (
                            <span className="font-medium text-green-600">
                              ${lead.treatment_value.toLocaleString()}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(lead.created_at), { addSuffix: true })}
                          </span>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                Showing {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
