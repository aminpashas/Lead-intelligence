'use client'

/**
 * Advanced Search — the Leads-page entry point for the shared AND/OR filter
 * builder. Opens a dialog hosting <AdvancedFilterBuilder>, applies the tree to
 * the `af` URL param (so the search is shareable/bookmarkable like every other
 * leads filter), and offers "Save as Smart List" which lifts the same tree into
 * a new smart_lists.criteria.filter — where all bulk actions already apply.
 */

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { SlidersHorizontal, Loader2, Bookmark } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { AdvancedFilterBuilder } from './advanced-filter-builder'
import { pruneFilterTree, type FilterNode } from '@/lib/campaigns/filter-tree'
import { encodeFilterParam, decodeFilterParam } from '@/lib/leads/filter-param'
import type { PipelineStage } from '@/types/database'

export function AdvancedSearchButton({ stages }: { stages: PipelineStage[] }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [open, setOpen] = useState(false)
  const [tree, setTree] = useState<FilterNode | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveName, setSaveName] = useState('')

  const active = !!searchParams.get('af')

  function openDialog() {
    // Sync the builder to whatever the URL currently carries.
    setTree(decodeFilterParam(searchParams.get('af')))
    setSaveName('')
    setOpen(true)
  }

  function apply() {
    const pruned = tree ? pruneFilterTree(tree) : null
    const params = new URLSearchParams(searchParams.toString())
    if (pruned) params.set('af', encodeFilterParam(pruned))
    else params.delete('af')
    params.set('page', '1')
    router.push(`/leads?${params.toString()}`)
    setOpen(false)
  }

  async function saveAsSmartList() {
    const pruned = tree ? pruneFilterTree(tree) : null
    if (!pruned) { toast.error('Add at least one condition first'); return }
    if (!saveName.trim()) { toast.error('Name your Smart List'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/smart-lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: saveName.trim(), criteria: { filter: pruned }, color: '#6366F1' }),
      })
      if (res.ok) {
        toast.success('Smart List created')
        setOpen(false)
      } else {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error || 'Failed to save Smart List')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={openDialog}
        className={cn(
          'h-8 gap-1.5',
          active && 'border-aurea-primary/40 bg-aurea-primary/10 text-aurea-primary'
        )}
      >
        <SlidersHorizontal className="h-[15px] w-[15px]" strokeWidth={1.75} />
        Advanced{active ? ' ·' : ''}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="aurea-display flex items-center gap-2 text-[20px] text-aurea-ink">
              <SlidersHorizontal className="h-[17px] w-[17px] text-aurea-primary" strokeWidth={1.75} />
              Advanced search
            </DialogTitle>
          </DialogHeader>

          <div className="mt-2 space-y-5">
            <AdvancedFilterBuilder value={tree} onChange={setTree} stages={stages} />

            <div className="flex flex-wrap items-end justify-between gap-3 border-t border-aurea-border pt-4">
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <Label className="text-[12px]">Save as Smart List</Label>
                  <Input
                    value={saveName}
                    onChange={(e) => setSaveName(e.target.value)}
                    placeholder="e.g. CA implant leads 30–65"
                    className="h-8 w-56"
                  />
                </div>
                <Button variant="outline" size="sm" onClick={saveAsSmartList} disabled={saving} className="h-8 gap-1.5">
                  {saving
                    ? <Loader2 className="h-[14px] w-[14px] animate-spin" />
                    : <Bookmark className="h-[14px] w-[14px]" strokeWidth={1.75} />}
                  Save
                </Button>
              </div>

              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setTree(null)}>Reset</Button>
                <Button size="sm" onClick={apply}>Apply search</Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
