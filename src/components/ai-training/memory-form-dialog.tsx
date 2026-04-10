'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
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
import type { AIMemory, AIMemoryCategory } from '@/types/database'

const CATEGORIES: { value: AIMemoryCategory; label: string }[] = [
  { value: 'tone_and_style', label: 'Tone & Style' },
  { value: 'product_knowledge', label: 'Product Knowledge' },
  { value: 'objection_handling', label: 'Objection Handling' },
  { value: 'pricing_rules', label: 'Pricing Rules' },
  { value: 'compliance_rules', label: 'Compliance Rules' },
  { value: 'general', label: 'General' },
]

type MemoryFormDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  memory?: AIMemory | null
  onSave: (data: {
    title: string
    category: AIMemoryCategory
    content: string
    is_enabled: boolean
    priority: number
  }) => Promise<void>
}

export function MemoryFormDialog({ open, onOpenChange, memory, onSave }: MemoryFormDialogProps) {
  const [title, setTitle] = useState(memory?.title || '')
  const [category, setCategory] = useState<AIMemoryCategory>(memory?.category || 'general')
  const [content, setContent] = useState(memory?.content || '')
  const [isEnabled, setIsEnabled] = useState(memory?.is_enabled ?? true)
  const [priority, setPriority] = useState(memory?.priority || 0)
  const [saving, setSaving] = useState(false)

  const isEditing = !!memory

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !content.trim()) return

    setSaving(true)
    try {
      await onSave({ title: title.trim(), category, content: content.trim(), is_enabled: isEnabled, priority })
      onOpenChange(false)
      // Reset form
      if (!isEditing) {
        setTitle('')
        setCategory('general')
        setContent('')
        setIsEnabled(true)
        setPriority(0)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Memory' : 'Add Training Memory'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="memory-title">Title</Label>
            <Input
              id="memory-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Always greet warmly"
              required
            />
          </div>

          <div>
            <Label htmlFor="memory-category">Category</Label>
            <Select value={category} onValueChange={(v) => v && setCategory(v as AIMemoryCategory)}>
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
            <Label htmlFor="memory-content">Training Instruction</Label>
            <Textarea
              id="memory-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Describe how the AI should behave or what it should know..."
              rows={5}
              required
            />
          </div>

          <div className="flex items-center gap-6">
            <div>
              <Label htmlFor="memory-priority">Priority (0-100)</Label>
              <Input
                id="memory-priority"
                type="number"
                min={0}
                max={100}
                value={priority}
                onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
                className="w-24"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={isEnabled} onCheckedChange={setIsEnabled} />
              <Label>Enabled</Label>
            </div>
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
