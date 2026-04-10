'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { X } from 'lucide-react'
import type { AIKnowledgeArticle, AIKnowledgeCategory } from '@/types/database'

const CATEGORIES: { value: AIKnowledgeCategory; label: string }[] = [
  { value: 'procedures', label: 'Procedures' },
  { value: 'pricing', label: 'Pricing' },
  { value: 'faqs', label: 'FAQs' },
  { value: 'aftercare', label: 'Aftercare' },
  { value: 'financing', label: 'Financing' },
  { value: 'general', label: 'General' },
]

type KnowledgeFormDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  article?: AIKnowledgeArticle | null
  onSave: (data: {
    title: string
    category: AIKnowledgeCategory
    content: string
    tags: string[]
    is_enabled: boolean
  }) => Promise<void>
}

export function KnowledgeFormDialog({ open, onOpenChange, article, onSave }: KnowledgeFormDialogProps) {
  const [title, setTitle] = useState(article?.title || '')
  const [category, setCategory] = useState<AIKnowledgeCategory>(article?.category || 'general')
  const [content, setContent] = useState(article?.content || '')
  const [tags, setTags] = useState<string[]>(article?.tags || [])
  const [tagInput, setTagInput] = useState('')
  const [isEnabled, setIsEnabled] = useState(article?.is_enabled ?? true)
  const [saving, setSaving] = useState(false)

  const isEditing = !!article

  // Sync form state when the article prop changes
  useEffect(() => {
    setTitle(article?.title || '')
    setCategory(article?.category || 'general')
    setContent(article?.content || '')
    setTags(article?.tags || [])
    setTagInput('')
    setIsEnabled(article?.is_enabled ?? true)
  }, [article])

  function addTag() {
    const tag = tagInput.trim().toLowerCase()
    if (tag && !tags.includes(tag)) {
      setTags([...tags, tag])
    }
    setTagInput('')
  }

  function removeTag(tag: string) {
    setTags(tags.filter((t) => t !== tag))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !content.trim()) return

    setSaving(true)
    try {
      await onSave({ title: title.trim(), category, content: content.trim(), tags, is_enabled: isEnabled })
      onOpenChange(false)
      if (!isEditing) {
        setTitle('')
        setCategory('general')
        setContent('')
        setTags([])
        setIsEnabled(true)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Article' : 'Add Knowledge Article'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="article-title">Title</Label>
            <Input
              id="article-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., All-on-4 Procedure Overview"
              required
            />
          </div>

          <div>
            <Label htmlFor="article-category">Category</Label>
            <Select value={category} onValueChange={(v) => v && setCategory(v as AIKnowledgeCategory)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="article-content">Content (Markdown supported)</Label>
            <Textarea
              id="article-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write the knowledge article content here..."
              rows={10}
              className="font-mono text-sm"
              required
            />
          </div>

          <div>
            <Label>Tags</Label>
            <div className="flex gap-2 mt-1">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="Add a tag..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addTag()
                  }
                }}
                className="flex-1"
              />
              <Button type="button" variant="outline" onClick={addTag} size="sm">
                Add
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1">
                    {tag}
                    <button type="button" onClick={() => removeTag(tag)} className="hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
            <Label>Enabled</Label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !title.trim() || !content.trim()}>
              {saving ? 'Saving...' : isEditing ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
