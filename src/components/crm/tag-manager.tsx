'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tags, Plus, Pencil, Trash2, Loader2, Users, Search,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { Tag, TagCategory } from '@/types/database'

const CATEGORY_LABELS: Record<TagCategory, string> = {
  pipeline_stage: 'Pipeline Stage',
  score: 'Score',
  interest: 'Interest',
  behavior: 'Behavior',
  custom: 'Custom',
}

const CATEGORY_COLORS: Record<TagCategory, string> = {
  pipeline_stage: 'bg-blue-100 text-blue-700',
  score: 'bg-amber-100 text-amber-700',
  interest: 'bg-green-100 text-green-700',
  behavior: 'bg-purple-100 text-purple-700',
  custom: 'bg-gray-100 text-gray-700',
}

const PRESET_COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#22C55E', '#10B981',
  '#06B6D4', '#3B82F6', '#6366F1', '#8B5CF6', '#EC4899',
  '#14B8A6', '#F43F5E', '#84CC16', '#A855F7', '#6B7280',
]

export function TagManager() {
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingTag, setEditingTag] = useState<Tag | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  // Form state
  const [formName, setFormName] = useState('')
  const [formColor, setFormColor] = useState('#6366F1')
  const [formCategory, setFormCategory] = useState<TagCategory>('custom')
  const [formDescription, setFormDescription] = useState('')

  useEffect(() => { fetchTags() }, [])

  async function fetchTags() {
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

  function openCreateDialog() {
    setEditingTag(null)
    setFormName('')
    setFormColor('#6366F1')
    setFormCategory('custom')
    setFormDescription('')
    setDialogOpen(true)
  }

  function openEditDialog(tag: Tag) {
    setEditingTag(tag)
    setFormName(tag.name)
    setFormColor(tag.color)
    setFormCategory(tag.category)
    setFormDescription(tag.description || '')
    setDialogOpen(true)
  }

  async function handleSave() {
    if (!formName.trim()) { toast.error('Tag name is required'); return }
    setSaving(true)
    try {
      const payload = {
        name: formName.trim(),
        color: formColor,
        category: formCategory,
        description: formDescription || undefined,
      }

      const res = editingTag
        ? await fetch(`/api/tags/${editingTag.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
        : await fetch('/api/tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })

      if (res.ok) {
        const { tag } = await res.json()
        if (editingTag) {
          setTags((prev) => prev.map((t) => (t.id === tag.id ? tag : t)))
        } else {
          setTags((prev) => [...prev, tag])
        }
        toast.success(editingTag ? 'Tag updated' : 'Tag created')
        setDialogOpen(false)
      } else {
        const err = await res.json()
        toast.error(err.error || 'Failed to save tag')
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id)
    try {
      const res = await fetch(`/api/tags/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setTags((prev) => prev.filter((t) => t.id !== id))
        toast.success('Tag deleted')
      } else {
        toast.error('Failed to delete tag')
      }
    } finally {
      setDeleting(null)
    }
  }

  const filtered = tags.filter((t) => {
    if (categoryFilter !== 'all' && t.category !== categoryFilter) return false
    if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const categoryGroups = Object.entries(
    filtered.reduce((acc, tag) => {
      const cat = tag.category || 'custom'
      if (!acc[cat]) acc[cat] = []
      acc[cat].push(tag)
      return acc
    }, {} as Record<string, Tag[]>)
  ).sort(([a], [b]) => a.localeCompare(b))

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Tags className="h-5 w-5" /> Tag Manager
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Organize leads with tags for filtering, Smart Lists, and campaign targeting
          </p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-1.5" onClick={openCreateDialog}>
              <Plus className="h-4 w-4" /> New Tag
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{editingTag ? 'Edit Tag' : 'Create Tag'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Name *</Label>
                <Input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g., Hot Lead, Financing Approved"
                />
              </div>

              <div className="space-y-2">
                <Label>Category</Label>
                <Select value={formCategory} onValueChange={(v) => setFormCategory(v as TagCategory)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                      <SelectItem key={key} value={key}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Color</Label>
                <div className="flex flex-wrap gap-1.5">
                  {PRESET_COLORS.map((color) => (
                    <button
                      key={color}
                      onClick={() => setFormColor(color)}
                      className={cn(
                        'h-7 w-7 rounded-full transition-all',
                        formColor === color && 'ring-2 ring-offset-2 ring-primary scale-110'
                      )}
                      style={{ backgroundColor: color }}
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <Label>Description (optional)</Label>
                <Input
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="What this tag represents..."
                />
              </div>

              {/* Preview */}
              <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50">
                <span className="text-xs text-muted-foreground">Preview:</span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium bg-background">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: formColor }} />
                  {formName || 'Tag Name'}
                </span>
              </div>

              <div className="flex gap-2 justify-end pt-2 border-t">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleSave} disabled={saving} className="gap-1.5">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {editingTag ? 'Update' : 'Create'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search tags..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
              <SelectItem key={key} value={key}>{label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Tags table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : tags.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-16">
            <Tags className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="font-medium">No tags yet</p>
            <p className="text-sm text-muted-foreground">
              Create tags to organize your leads for campaigns and Smart Lists
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tag</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Leads</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((tag) => (
                  <TableRow key={tag.id}>
                    <TableCell>
                      <span className="inline-flex items-center gap-2 font-medium">
                        <span
                          className="h-3 w-3 rounded-full ring-1 ring-black/10"
                          style={{ backgroundColor: tag.color }}
                        />
                        {tag.name}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge className={cn('text-xs', CATEGORY_COLORS[tag.category])}>
                        {CATEGORY_LABELS[tag.category]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm text-muted-foreground">
                        {tag.description || '—'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center gap-1 text-sm">
                        <Users className="h-3.5 w-3.5 text-muted-foreground" />
                        {tag.lead_count}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openEditDialog(tag)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 hover:text-destructive"
                          onClick={() => handleDelete(tag.id)}
                          disabled={deleting === tag.id}
                        >
                          {deleting === tag.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      {tags.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {Object.entries(CATEGORY_LABELS).map(([key, label]) => {
            const count = tags.filter((t) => t.category === key).length
            const leadsCount = tags
              .filter((t) => t.category === key)
              .reduce((sum, t) => sum + t.lead_count, 0)
            return (
              <Card key={key}>
                <CardContent className="pt-4 text-center">
                  <p className="text-lg font-bold">{count}</p>
                  <p className="text-xs text-muted-foreground">{label} tags</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{leadsCount} leads</p>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
