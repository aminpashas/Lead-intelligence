'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { Button } from '@/components/ui/button'
import {
  ListFilter, Plus, Users, Megaphone, Pin, Pencil, Trash2,
  Loader2, Sparkles, Target, LayoutGrid, List,
} from 'lucide-react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
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
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const router = useRouter()
  const searchParams = useSearchParams()

  // Read the saved view preference after mount — the server render can't know
  // it, and seeding useState from localStorage would break hydration.
  useEffect(() => {
    if (localStorage.getItem('smart-lists:view') === 'list') setViewMode('list')
  }, [])

  function switchView(mode: 'grid' | 'list') {
    setViewMode(mode)
    localStorage.setItem('smart-lists:view', mode)
  }

  // Deep-link support: a Pipeline "Move to stage" recommendation lands here with
  // ?list=<id> — auto-open that segment's detail (where the bulk stage-move
  // action lives) so the user can review and apply the move.
  useEffect(() => {
    const listId = searchParams.get('list')
    if (!listId) return
    const match = initial.find((l) => l.id === listId)
    if (match) setViewingList(match)
  }, [searchParams, initial])

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
        stages={stages}
        tags={tags}
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
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-md ring-1 ring-inset ring-aurea-border">
            <button
              onClick={() => switchView('grid')}
              aria-label="Grid view"
              aria-pressed={viewMode === 'grid'}
              className={`flex h-8 w-8 items-center justify-center rounded-l-md transition-colors ${
                viewMode === 'grid'
                  ? 'bg-aurea-surface-2 text-aurea-ink'
                  : 'text-aurea-ink-3 hover:text-aurea-ink'
              }`}
            >
              <LayoutGrid className="h-4 w-4" strokeWidth={1.75} />
            </button>
            <button
              onClick={() => switchView('list')}
              aria-label="List view"
              aria-pressed={viewMode === 'list'}
              className={`flex h-8 w-8 items-center justify-center rounded-r-md border-l border-aurea-border transition-colors ${
                viewMode === 'list'
                  ? 'bg-aurea-surface-2 text-aurea-ink'
                  : 'text-aurea-ink-3 hover:text-aurea-ink'
              }`}
            >
              <List className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
          <Button className="gap-1.5" onClick={handleCreate}>
            <Plus className="h-4 w-4" strokeWidth={1.75} /> Create Smart List
          </Button>
        </div>
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

      {smartLists.length === 0 ? (
        /* Empty state — shown in both views */
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
      ) : viewMode === 'list' ? (
        /* List view — pinned first, one dense table */
        <SmartListsTable
          lists={[...pinned, ...unpinned]}
          onView={(list) => setViewingList(list)}
          onEdit={(list) => handleEdit(list)}
          onDelete={(list) => setConfirmDeleteId(list.id)}
          deleting={deleting}
        />
      ) : (
        <>
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
                    onDelete={() => setConfirmDeleteId(list.id)}
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
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {unpinned.map((list) => (
                <SmartListCard
                  key={list.id}
                  list={list}
                  onView={() => setViewingList(list)}
                  onEdit={() => handleEdit(list)}
                  onDelete={() => setConfirmDeleteId(list.id)}
                  deleting={deleting === list.id}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={confirmDeleteId !== null}
        onOpenChange={(open) => { if (!open) setConfirmDeleteId(null) }}
        title="Delete Smart List"
        description="Delete this Smart List? Campaigns targeting it will stop matching."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (confirmDeleteId) await handleDelete(confirmDeleteId)
        }}
      />

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

// How many of a Smart List's criteria fields are actually set. Shared by the
// card and the list-view row so the "N filters" count can't drift between them.
function countActiveCriteria(criteria: SmartList['criteria']): number {
  return Object.keys(criteria).filter((k) => {
    const val = (criteria as any)[k]
    if (val === undefined || val === null || val === false) return false
    if (Array.isArray(val) && val.length === 0) return false
    if (typeof val === 'object' && 'ids' in val && val.ids.length === 0) return false
    return true
  }).length
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
  const criteriaCount = countActiveCriteria(list.criteria)

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
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Edit smart list"
            className="h-7 w-7 text-aurea-ink-3 hover:text-aurea-ink"
            onClick={(e) => { e.stopPropagation(); onEdit() }}
          >
            <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Delete smart list"
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

function SmartListsTable({
  lists,
  onView,
  onEdit,
  onDelete,
  deleting,
}: {
  lists: SmartList[]
  onView: (list: SmartList) => void
  onEdit: (list: SmartList) => void
  onDelete: (list: SmartList) => void
  deleting: string | null
}) {
  return (
    <div className="aurea-card overflow-hidden">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-aurea-border">
            <th className="px-4 py-3 aurea-eyebrow font-medium">List</th>
            <th className="px-4 py-3 aurea-eyebrow font-medium text-right">Leads</th>
            <th className="hidden px-4 py-3 aurea-eyebrow font-medium text-right sm:table-cell">Filters</th>
            <th className="hidden px-4 py-3 aurea-eyebrow font-medium md:table-cell">Updated</th>
            <th className="px-4 py-3 aurea-eyebrow font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {lists.map((list) => {
            const criteriaCount = countActiveCriteria(list.criteria)
            const isDeleting = deleting === list.id
            return (
              <tr
                key={list.id}
                className="group cursor-pointer border-b border-aurea-border transition-colors last:border-b-0 hover:bg-aurea-surface-2"
                onClick={() => onView(list)}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    {list.is_pinned && (
                      <Pin className="h-3 w-3 shrink-0 text-aurea-ink-3" strokeWidth={1.75} aria-label="Pinned" />
                    )}
                    <span className="font-semibold text-[13.5px] text-aurea-ink">{list.name}</span>
                  </div>
                  {list.description && (
                    <p className="mt-0.5 line-clamp-1 text-[11.5px] text-aurea-ink-3">{list.description}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="font-mono text-[12px] tabular-nums font-medium text-aurea-ink">
                    {list.lead_count.toLocaleString()}
                  </span>
                </td>
                <td className="hidden px-4 py-3 text-right sm:table-cell">
                  <span className="inline-flex items-center rounded-full border border-aurea-border bg-aurea-surface-2 px-2 py-0.5 text-[10px] font-medium text-aurea-ink-3">
                    {criteriaCount} filter{criteriaCount !== 1 ? 's' : ''}
                  </span>
                </td>
                <td className="hidden px-4 py-3 md:table-cell">
                  <span className="font-mono text-[10.5px] tabular-nums text-aurea-ink-3">
                    {list.last_refreshed_at
                      ? formatDistanceToNow(new Date(list.last_refreshed_at), { addSuffix: true })
                      : '—'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Edit smart list"
                      className="h-7 w-7 text-aurea-ink-3 hover:text-aurea-ink"
                      onClick={(e) => { e.stopPropagation(); onEdit(list) }}
                    >
                      <Pencil className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete smart list"
                      className="h-7 w-7 text-aurea-ink-3 hover:text-aurea-rose"
                      onClick={(e) => { e.stopPropagation(); onDelete(list) }}
                      disabled={isDeleting}
                    >
                      {isDeleting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                      )}
                    </Button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
