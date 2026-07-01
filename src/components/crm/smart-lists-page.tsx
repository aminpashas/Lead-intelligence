'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { Button } from '@/components/ui/button'
import {
  ListFilter, Plus, Users, Megaphone, Pin, Pencil, Trash2,
  Loader2, Sparkles, Target,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { SmartListBuilder } from './smart-list-builder'
import { SmartListDetail } from './smart-list-detail'
import type { SmartList, PipelineStage, Tag } from '@/types/database'

interface SmartListsPageProps {
  smartLists: SmartList[]
  stages: PipelineStage[]
  tags: Tag[]
}

export function SmartListsPage({ smartLists: initial, stages, tags }: SmartListsPageProps) {
  const [smartLists, setSmartLists] = useState(initial)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [editingList, setEditingList] = useState<SmartList | null>(null)
  const [viewingList, setViewingList] = useState<SmartList | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const router = useRouter()

  async function refresh() {
    const res = await fetch('/api/smart-lists')
    if (res.ok) {
      const data = await res.json()
      setSmartLists(data.smart_lists)
    }
  }

  function handleEdit(list: SmartList) {
    setEditingList(list)
    setBuilderOpen(true)
  }

  async function handleDelete(id: string) {
    setDeleting(id)
    try {
      const res = await fetch(`/api/smart-lists/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setSmartLists((prev) => prev.filter((l) => l.id !== id))
        toast.success('Smart List deleted')
      } else {
        toast.error('Failed to delete')
      }
    } finally {
      setDeleting(null)
    }
  }

  function handleCreate() {
    setEditingList(null)
    setBuilderOpen(true)
  }

  // If viewing a specific Smart List
  if (viewingList) {
    return (
      <SmartListDetail
        smartList={viewingList}
        onEdit={() => handleEdit(viewingList)}
        onBack={() => {
          setViewingList(null)
          refresh()
        }}
      />
    )
  }

  const pinned = smartLists.filter((l) => l.is_pinned)
  const unpinned = smartLists.filter((l) => !l.is_pinned)
  const totalLeads = smartLists.reduce((sum, l) => sum + l.lead_count, 0)

  return (
    <div className="space-y-6 animate-in fade-in-0 duration-500">
      {/* Header */}
      <header className="flex items-end justify-between border-b border-aurea-border pb-6">
        <div>
          <p className="aurea-eyebrow mb-2">Lead Segmentation</p>
          <h1 className="aurea-display text-[32px] text-aurea-ink sm:text-[40px] flex items-center gap-2">
            <Sparkles className="h-[22px] w-[22px] text-aurea-primary" strokeWidth={1.75} />
            Smart Lists
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-aurea-ink-2">
            Dynamic lead segments for targeted campaigns and mass messaging
          </p>
        </div>
        <Button className="gap-1.5" onClick={handleCreate}>
          <Plus className="h-4 w-4" strokeWidth={1.75} /> Create Smart List
        </Button>
      </header>

      {/* Stats Overview */}
      <div className="grid grid-cols-3 gap-3">
        <div className="aurea-card p-5">
          <div className="flex items-center justify-between">
            <p className="aurea-eyebrow">Smart Lists</p>
            <ListFilter className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
          </div>
          <p className="mt-4 aurea-display text-[40px] tabular-nums text-aurea-ink">{smartLists.length}</p>
        </div>
        <div className="aurea-card p-5">
          <div className="flex items-center justify-between">
            <p className="aurea-eyebrow">Segmented Leads</p>
            <Users className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
          </div>
          <p className="mt-4 aurea-display text-[40px] tabular-nums text-aurea-ink">{totalLeads.toLocaleString()}</p>
        </div>
        <div className="aurea-card p-5">
          <div className="flex items-center justify-between">
            <p className="aurea-eyebrow">Pinned Lists</p>
            <Target className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
          </div>
          <p className="mt-4 aurea-display text-[40px] tabular-nums text-aurea-ink">{pinned.length}</p>
        </div>
      </div>

      {/* Pinned Lists */}
      {pinned.length > 0 && (
        <div>
          <p className="aurea-eyebrow mb-3 flex items-center gap-1.5">
            <Pin className="h-3 w-3" strokeWidth={1.75} /> Pinned
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {pinned.map((list) => (
              <SmartListCard
                key={list.id}
                list={list}
                onView={() => setViewingList(list)}
                onEdit={() => handleEdit(list)}
                onDelete={() => handleDelete(list.id)}
                deleting={deleting === list.id}
              />
            ))}
          </div>
        </div>
      )}

      {/* All Lists */}
      <div>
        {pinned.length > 0 && (
          <p className="aurea-eyebrow mb-3">All Lists</p>
        )}
        {smartLists.length === 0 ? (
          <div className="aurea-card">
            <div className="flex flex-col items-center py-16">
              <Sparkles className="h-10 w-10 text-aurea-ink-3 mb-3" strokeWidth={1.75} />
              <p className="font-medium text-aurea-ink">No Smart Lists yet</p>
              <p className="text-[13px] text-aurea-ink-3 mb-4 mt-1">
                Create your first Smart List to segment leads for targeted campaigns
              </p>
              <Button onClick={handleCreate} className="gap-1.5">
                <Plus className="h-4 w-4" strokeWidth={1.75} /> Create Smart List
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {unpinned.map((list) => (
              <SmartListCard
                key={list.id}
                list={list}
                onView={() => setViewingList(list)}
                onEdit={() => handleEdit(list)}
                onDelete={() => handleDelete(list.id)}
                deleting={deleting === list.id}
              />
            ))}
          </div>
        )}
      </div>

      {/* Smart List Builder Dialog */}
      <SmartListBuilder
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        initialValues={editingList ? {
          id: editingList.id,
          name: editingList.name,
          description: editingList.description || '',
          color: editingList.color,
          criteria: editingList.criteria,
          is_pinned: editingList.is_pinned,
        } : undefined}
        stages={stages}
        tags={tags}
        onSaved={refresh}
      />
    </div>
  )
}

function SmartListCard({
  list,
  onView,
  onEdit,
  onDelete,
  deleting,
}: {
  list: SmartList
  onView: () => void
  onEdit: () => void
  onDelete: () => void
  deleting: boolean
}) {
  const criteriaCount = Object.keys(list.criteria).filter(
    (k) => {
      const val = (list.criteria as any)[k]
      if (val === undefined || val === null || val === false) return false
      if (Array.isArray(val) && val.length === 0) return false
      if (typeof val === 'object' && 'ids' in val && val.ids.length === 0) return false
      return true
    }
  ).length

  return (
    <div
      className="aurea-card group cursor-pointer p-5 transition-colors hover:bg-aurea-surface-2"
      onClick={onView}
    >
      <div className="flex items-start justify-between mb-3">
        <div
          className="h-9 w-9 rounded-lg flex items-center justify-center border border-aurea-border bg-aurea-surface-2"
        >
          <ListFilter className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-aurea-ink-3 hover:text-aurea-ink"
            onClick={(e) => { e.stopPropagation(); onEdit() }}
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-aurea-ink-3 hover:text-aurea-rose"
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            disabled={deleting}
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
          </Button>
        </div>
      </div>

      <h3 className="font-semibold text-[13.5px] text-aurea-ink mb-0.5">{list.name}</h3>
      {list.description && (
        <p className="text-[11.5px] text-aurea-ink-3 line-clamp-2 mb-3">{list.description}</p>
      )}

      <div className="flex items-center justify-between mt-3 pt-3 border-t border-aurea-border">
        <div className="flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />
          <span className="font-mono text-[12px] tabular-nums font-medium text-aurea-ink">{list.lead_count.toLocaleString()}</span>
          <span className="text-[11px] text-aurea-ink-3">leads</span>
        </div>
        <span className="inline-flex items-center rounded-full border border-aurea-border bg-aurea-surface-2 px-2 py-0.5 text-[10px] font-medium text-aurea-ink-3">
          {criteriaCount} filter{criteriaCount !== 1 ? 's' : ''}
        </span>
      </div>

      {list.last_refreshed_at && (
        <p className="font-mono text-[10px] tabular-nums text-aurea-ink-3 mt-1.5">
          Updated {formatDistanceToNow(new Date(list.last_refreshed_at), { addSuffix: true })}
        </p>
      )}
    </div>
  )
}
