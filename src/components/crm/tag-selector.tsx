'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { Check, Plus, Search, Tags, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { Tag } from '@/types/database'

interface TagSelectorProps {
  selectedTagIds: string[]
  onTagsChange: (tagIds: string[]) => void
  /** Pre-loaded tags (if available). If not provided, fetches from API. */
  availableTags?: Tag[]
  placeholder?: string
  className?: string
}

const QUICK_COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#22C55E', '#10B981',
  '#06B6D4', '#3B82F6', '#6366F1', '#8B5CF6', '#EC4899',
]

export function TagSelector({
  selectedTagIds,
  onTagsChange,
  availableTags: initialTags,
  placeholder = 'Select tags...',
  className,
}: TagSelectorProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [tags, setTags] = useState<Tag[]>(initialTags || [])
  const [loading, setLoading] = useState(!initialTags)
  const [creating, setCreating] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState('#6366F1')

  useEffect(() => {
    if (!initialTags) {
      fetchTags()
    }
  }, [initialTags])

  async function fetchTags() {
    setLoading(true)
    try {
      const res = await fetch('/api/tags')
      if (res.ok) {
        const data = await res.json()
        setTags(data.tags)
      }
    } finally {
      setLoading(false)
    }
  }

  async function createTag() {
    if (!newTagName.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTagName.trim(), color: newTagColor }),
      })
      if (res.ok) {
        const { tag } = await res.json()
        setTags((prev) => [...prev, tag])
        onTagsChange([...selectedTagIds, tag.id])
        setNewTagName('')
        setShowCreate(false)
        toast.success(`Tag "${tag.name}" created`)
      } else {
        const err = await res.json()
        toast.error(err.error || 'Failed to create tag')
      }
    } finally {
      setCreating(false)
    }
  }

  function toggleTag(tagId: string) {
    if (selectedTagIds.includes(tagId)) {
      onTagsChange(selectedTagIds.filter((id) => id !== tagId))
    } else {
      onTagsChange([...selectedTagIds, tagId])
    }
  }

  const filtered = tags.filter((t) =>
    t.name.toLowerCase().includes(search.toLowerCase())
  )

  const selectedTags = tags.filter((t) => selectedTagIds.includes(t.id))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger>
        <span
          className={cn('inline-flex items-center justify-start gap-2 font-normal rounded-md border border-input bg-background px-3 py-2 text-sm cursor-pointer hover:bg-accent/50 transition-colors', className)}
          id="tag-selector-trigger"
        >
          <Tags className="h-4 w-4 text-muted-foreground" />
          {selectedTags.length > 0 ? (
            <span className="flex items-center gap-1">
              {selectedTags.slice(0, 2).map((t) => (
                <Badge key={t.id} variant="secondary" className="text-xs px-1.5 py-0 gap-1">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: t.color }} />
                  {t.name}
                </Badge>
              ))}
              {selectedTags.length > 2 && (
                <span className="text-xs text-muted-foreground">+{selectedTags.length - 2}</span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        {/* Search */}
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search tags..."
              className="pl-8 h-8 text-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Tag list */}
        <div className="max-h-48 overflow-y-auto p-1">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              {search ? 'No tags found' : 'No tags yet'}
            </p>
          ) : (
            filtered.map((tag) => {
              const isSelected = selectedTagIds.includes(tag.id)
              return (
                <button
                  key={tag.id}
                  onClick={() => toggleTag(tag.id)}
                  className={cn(
                    'flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm transition-colors',
                    isSelected ? 'bg-accent' : 'hover:bg-accent/50'
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 rounded-full shrink-0 ring-1 ring-black/10"
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className="flex-1 text-left truncate">{tag.name}</span>
                  <span className="text-xs text-muted-foreground">{tag.lead_count}</span>
                  {isSelected && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                </button>
              )
            })
          )}
        </div>

        {/* Create new tag */}
        <div className="border-t p-2">
          {showCreate ? (
            <div className="space-y-2">
              <Input
                placeholder="Tag name..."
                className="h-8 text-sm"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createTag()}
                autoFocus
              />
              <div className="flex items-center gap-1">
                {QUICK_COLORS.map((color) => (
                  <button
                    key={color}
                    onClick={() => setNewTagColor(color)}
                    className={cn(
                      'h-5 w-5 rounded-full transition-transform',
                      newTagColor === color && 'ring-2 ring-offset-1 ring-primary scale-110'
                    )}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" className="flex-1 h-7 text-xs" onClick={createTag} disabled={creating}>
                  {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Create'}
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-1.5 h-7 text-xs"
              onClick={() => setShowCreate(true)}
            >
              <Plus className="h-3 w-3" />
              Create new tag
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
