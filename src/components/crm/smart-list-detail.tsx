'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { Card, CardContent } from '@/components/ui/card'
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
  ChevronRight, Loader2, RefreshCw, MessageSquare, Mail,
} from 'lucide-react'
import { toast } from 'sonner'
import { TagBadgeList } from './tag-badge'
import { SmartListBulkActions } from './smart-list-bulk-actions'
import type { Lead, SmartList, Tag, PipelineStage } from '@/types/database'

// Lead qualification chips — Aurea semantic colors, no blue
const qualificationColors: Record<string, string> = {
  hot: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20',
  warm: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  cold: 'bg-aurea-surface-2 text-aurea-ink-2 border border-aurea-border',
  unqualified: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
  unscored: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
}

interface SmartListDetailProps {
  smartList: SmartList
  stages?: PipelineStage[]
  tags?: Tag[]
  onEdit: () => void
  onBack: () => void
}

export function SmartListDetail({ smartList, stages = [], tags = [], onEdit, onBack }: SmartListDetailProps) {
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
  if (c.conversation_intents?.length) criteriaLabels.push(`Intent: ${c.conversation_intents.join(', ').replace(/_/g, ' ')}`)
  if (c.conversation_sentiments?.length) criteriaLabels.push(`Sentiment: ${c.conversation_sentiments.join(', ')}`)
  if (c.primary_objections?.length) criteriaLabels.push(`Objection: ${c.primary_objections.join(', ').replace(/_/g, ' ')}`)
  if (c.conversation_red_flag) criteriaLabels.push('Red-flagged')
  if (c.score_min || c.score_max) criteriaLabels.push(`Score: ${c.score_min || 0}–${c.score_max || 100}`)
  if (c.source_types?.length) criteriaLabels.push(`${c.source_types.length} sources`)
  if (c.has_phone) criteriaLabels.push('Has phone')
  if (c.has_email) criteriaLabels.push('Has email')
  if (c.sms_consent) criteriaLabels.push('SMS consent')
  if (c.lead_ids?.length) criteriaLabels.push(`Pinned snapshot: ${c.lead_ids.length} leads`)

  return (
    <div className="space-y-6 animate-in fade-in-0 duration-500">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-aurea-border pb-6">
        <Button variant="ghost" size="icon" onClick={onBack} className="text-aurea-ink-3 hover:text-aurea-ink">
          <ArrowLeft className="h-[17px] w-[17px]" strokeWidth={1.75} />
        </Button>
        <div
          className="h-10 w-10 rounded-lg flex items-center justify-center border border-aurea-border bg-aurea-surface-2"
        >
          <Users className="h-[17px] w-[17px] text-aurea-ink-2" strokeWidth={1.75} />
        </div>
        <div className="flex-1">
          <h1 className="aurea-display text-[22px] text-aurea-ink">{smartList.name}</h1>
          {smartList.description && (
            <p className="text-[13px] text-aurea-ink-3 mt-0.5">{smartList.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} className="gap-1.5">
            {refreshing
              ? <Loader2 className="h-[15px] w-[15px] animate-spin" />
              : <RefreshCw className="h-[15px] w-[15px]" strokeWidth={1.75} />}
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit} className="gap-1.5">
            <Pencil className="h-[15px] w-[15px]" strokeWidth={1.75} />
            Edit
          </Button>
          <SmartListBulkActions
            smartList={smartList}
            total={total}
            stages={stages}
            tags={tags}
            onDone={handleRefresh}
          />
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => router.push(`/campaigns/broadcasts/sms?smart_list_id=${smartList.id}`)}
          >
            <MessageSquare className="h-[15px] w-[15px]" strokeWidth={1.75} />
            Mass SMS
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => router.push(`/campaigns/broadcasts/email?smart_list_id=${smartList.id}`)}
          >
            <Mail className="h-[15px] w-[15px]" strokeWidth={1.75} />
            Mass Email
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => router.push(`/campaigns?smart_list_id=${smartList.id}`)}
          >
            <Megaphone className="h-[15px] w-[15px]" strokeWidth={1.75} />
            Launch Campaign
          </Button>
        </div>
      </div>

      {/* Stats & Criteria */}
      <div className="grid grid-cols-4 gap-3">
        <div className="aurea-card p-5">
          <p className="aurea-eyebrow mb-3">Matching Leads</p>
          <p className="aurea-display text-[40px] tabular-nums text-aurea-ink">{total.toLocaleString()}</p>
        </div>
        <div className="aurea-card col-span-3 p-5">
          <p className="aurea-eyebrow mb-3">Active Filters</p>
          <div className="flex flex-wrap gap-1.5">
            {criteriaLabels.length > 0 ? criteriaLabels.map((label, i) => (
              <span
                key={i}
                className="inline-flex items-center rounded-full border border-aurea-border bg-aurea-surface-2 px-2.5 py-0.5 text-[11px] font-medium text-aurea-ink-2 capitalize"
              >
                {label}
              </span>
            )) : (
              <span className="text-[12px] text-aurea-ink-3">No filters set — showing all leads</span>
            )}
          </div>
        </div>
      </div>

      {/* Leads Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-aurea-ink-3" />
        </div>
      ) : leads.length === 0 ? (
        <div className="aurea-card">
          <div className="flex flex-col items-center py-16">
            <Users className="h-10 w-10 text-aurea-ink-3 mb-3" strokeWidth={1.75} />
            <p className="font-medium text-aurea-ink">No matching leads</p>
            <p className="text-[13px] text-aurea-ink-3 mt-1">
              Adjust your filters to match more leads
            </p>
          </div>
        </div>
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
                        className="cursor-pointer hover:bg-aurea-surface-2"
                        onClick={() => router.push(`/leads/${lead.id}`)}
                      >
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="h-8 w-8">
                              <AvatarFallback className="text-xs bg-aurea-surface-2 text-aurea-ink-2">{initials}</AvatarFallback>
                            </Avatar>
                            <div>
                              <p className="font-medium text-[13px] text-aurea-ink">
                                {lead.first_name} {lead.last_name}
                              </p>
                              <p className="text-[11px] text-aurea-ink-3">
                                {lead.email || lead.phone}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${qualificationColors[lead.ai_qualification] || qualificationColors.unscored}`}>
                            <Brain className="h-3 w-3" strokeWidth={1.75} />
                            <span className="font-mono tabular-nums">{lead.ai_score}</span>
                          </span>
                        </TableCell>
                        <TableCell>
                          {lead.pipeline_stage && (
                            <div className="flex items-center gap-1.5">
                              <div
                                className="h-1.5 w-1.5 rounded-full shrink-0"
                                style={{ backgroundColor: lead.pipeline_stage.color }}
                              />
                              <span className="text-[13px] text-aurea-ink-2">{lead.pipeline_stage.name}</span>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[11px] capitalize">
                            {lead.status.replace(/_/g, ' ')}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-[13px] text-aurea-ink-3 capitalize">
                            {lead.source_type?.replace(/_/g, ' ') || '—'}
                          </span>
                        </TableCell>
                        <TableCell>
                          {lead.treatment_value ? (
                            <span className="font-mono tabular-nums text-[13px] font-medium text-aurea-primary">
                              ${lead.treatment_value.toLocaleString()}
                            </span>
                          ) : (
                            <span className="text-aurea-ink-3">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
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
              <p className="font-mono text-[12px] tabular-nums text-aurea-ink-3">
                Showing {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft className="h-[15px] w-[15px]" strokeWidth={1.75} />
                </Button>
                <span className="font-mono text-[12px] tabular-nums text-aurea-ink-2">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight className="h-[15px] w-[15px]" strokeWidth={1.75} />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
