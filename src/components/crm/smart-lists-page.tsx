'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  ListFilter, Plus, Users, Megaphone, Pin, Pencil, Trash2,
  Loader2, Sparkles, BarChart3, Target, TrendingUp,
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-primary" />
            Smart Lists
          </h1>
          <p className="text-muted-foreground mt-0.5">
            Dynamic lead segments for targeted campaigns and mass messaging
          </p>
        </div>
        <Button className="gap-1.5" onClick={handleCreate}>
          <Plus className="h-4 w-4" /> Create Smart List
        </Button>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="pt-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <ListFilter className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-2xl font-bold">{smartLists.length}</p>
              <p className="text-xs text-muted-foreground">Smart Lists</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <Users className="h-5 w-5 text-blue-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalLeads.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">Total Segmented Leads</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-green-500/10 flex items-center justify-center">
              <Target className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <p className="text-2xl font-bold">{pinned.length}</p>
              <p className="text-xs text-muted-foreground">Pinned Lists</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pinned Lists */}
      {pinned.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-1.5">
            <Pin className="h-3.5 w-3.5" /> Pinned
          </h2>
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
          <h2 className="text-sm font-semibold text-muted-foreground mb-3">
            All Lists
          </h2>
        )}
        {smartLists.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center py-16">
              <Sparkles className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="font-medium">No Smart Lists yet</p>
              <p className="text-sm text-muted-foreground mb-4">
                Create your first Smart List to segment leads for targeted campaigns
              </p>
              <Button onClick={handleCreate} className="gap-1.5">
                <Plus className="h-4 w-4" /> Create Smart List
              </Button>
            </CardContent>
          </Card>
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
    <Card
      className="group hover:border-primary/30 transition-all cursor-pointer"
      onClick={onView}
    >
      <CardContent className="pt-5">
        <div className="flex items-start justify-between mb-3">
          <div
            className="h-9 w-9 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: list.color + '15' }}
          >
            <ListFilter className="h-4 w-4" style={{ color: list.color }} />
          </div>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={(e) => { e.stopPropagation(); onEdit() }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); onDelete() }}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
        </div>

        <h3 className="font-semibold text-sm mb-0.5">{list.name}</h3>
        {list.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{list.description}</p>
        )}

        <div className="flex items-center justify-between mt-3 pt-3 border-t">
          <div className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-sm font-medium">{list.lead_count.toLocaleString()}</span>
            <span className="text-xs text-muted-foreground">leads</span>
          </div>
          <Badge variant="secondary" className="text-xs">
            {criteriaCount} filter{criteriaCount !== 1 ? 's' : ''}
          </Badge>
        </div>

        {list.last_refreshed_at && (
          <p className="text-[10px] text-muted-foreground mt-1.5">
            Updated {formatDistanceToNow(new Date(list.last_refreshed_at), { addSuffix: true })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
