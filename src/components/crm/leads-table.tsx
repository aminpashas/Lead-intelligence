'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Brain, ChevronLeft, ChevronRight, Search, Tags } from 'lucide-react'
import { TagBadgeList } from './tag-badge'
import type { Lead, PipelineStage, Tag } from '@/types/database'
import { useState } from 'react'

const qualificationColors: Record<string, string> = {
  hot: 'bg-red-100 text-red-800',
  warm: 'bg-orange-100 text-orange-800',
  cold: 'bg-blue-100 text-blue-800',
  unqualified: 'bg-gray-100 text-gray-600',
  unscored: 'bg-gray-50 text-gray-400',
}

export function LeadsTable({
  leads,
  stages,
  total,
  page,
  perPage,
  allTags,
  leadTagsMap,
}: {
  leads: Lead[]
  stages: PipelineStage[]
  total: number
  page: number
  perPage: number
  allTags?: Tag[]
  leadTagsMap?: Record<string, Tag[]>
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [search, setSearch] = useState(searchParams.get('search') || '')

  function updateFilters(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (value && value !== 'all') {
      params.set(key, value)
    } else {
      params.delete(key)
    }
    params.set('page', '1')
    router.push(`/leads?${params.toString()}`)
  }

  function handleSearch() {
    updateFilters('search', search)
  }

  const totalPages = Math.ceil(total / perPage)

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search leads..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="pl-9"
          />
        </div>

        <Select
          value={searchParams.get('qualification') || 'all'}
          onValueChange={(v) => updateFilters('qualification', v)}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Qualification" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Scores</SelectItem>
            <SelectItem value="hot">Hot</SelectItem>
            <SelectItem value="warm">Warm</SelectItem>
            <SelectItem value="cold">Cold</SelectItem>
            <SelectItem value="unqualified">Unqualified</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={searchParams.get('status') || 'all'}
          onValueChange={(v) => updateFilters('status', v)}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="new">New</SelectItem>
            <SelectItem value="contacted">Contacted</SelectItem>
            <SelectItem value="qualified">Qualified</SelectItem>
            <SelectItem value="consultation_scheduled">Consult Scheduled</SelectItem>
            <SelectItem value="treatment_presented">Treatment Presented</SelectItem>
            <SelectItem value="contract_signed">Contract Signed</SelectItem>
            <SelectItem value="lost">Lost</SelectItem>
          </SelectContent>
        </Select>

        {/* Tag Filter */}
        {allTags && allTags.length > 0 && (
          <Select
            value={searchParams.get('tag') || 'all'}
            onValueChange={(v) => updateFilters('tag', v)}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Filter by tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Tags</SelectItem>
              {allTags.map((tag) => (
                <SelectItem key={tag.id} value={tag.slug}>
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    {tag.name}
                    <span className="text-muted-foreground ml-1">({tag.lead_count})</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lead</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Tags</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Engagement</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((lead) => {
              const initials = `${lead.first_name?.[0] || ''}${lead.last_name?.[0] || ''}`.toUpperCase()
              const tags = leadTagsMap?.[lead.id] || []
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
                    {tags.length > 0 ? (
                      <TagBadgeList tags={tags} maxVisible={2} compact />
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="text-sm">
                      {lead.dental_condition?.replace(/_/g, ' ') || '—'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">
                      {lead.source_type?.replace(/_/g, ' ') || '—'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div className="text-xs text-muted-foreground">
                      {lead.total_messages_sent + lead.total_messages_received} msgs
                    </div>
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
      </div>

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
              onClick={() => updateFilters('page', String(page - 1))}
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
              onClick={() => updateFilters('page', String(page + 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
