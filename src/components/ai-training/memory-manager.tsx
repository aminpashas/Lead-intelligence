'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, Pencil, Trash2, Brain } from 'lucide-react'
import { MemoryFormDialog } from './memory-form-dialog'
import type { AIMemory, AIMemoryCategory } from '@/types/database'
import { toast } from 'sonner'

const CATEGORY_LABELS: Record<AIMemoryCategory, string> = {
  tone_and_style: 'Tone & Style',
  product_knowledge: 'Product Knowledge',
  objection_handling: 'Objection Handling',
  pricing_rules: 'Pricing Rules',
  compliance_rules: 'Compliance Rules',
  general: 'General',
}

const CATEGORY_COLORS: Record<AIMemoryCategory, string> = {
  tone_and_style: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  product_knowledge: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  objection_handling: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  pricing_rules: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  compliance_rules: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  general: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300',
}

export function MemoryManager() {
  const [memories, setMemories] = useState<AIMemory[]>([])
  const [loading, setLoading] = useState(true)
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingMemory, setEditingMemory] = useState<AIMemory | null>(null)

  const fetchMemories = useCallback(async () => {
    try {
      const url = categoryFilter === 'all'
        ? '/api/ai/training/memories'
        : `/api/ai/training/memories?category=${categoryFilter}`
      const res = await fetch(url)
      const data = await res.json()
      setMemories(data.memories || [])
    } catch {
      toast.error('Failed to load memories')
    } finally {
      setLoading(false)
    }
  }, [categoryFilter])

  useEffect(() => {
    fetchMemories()
  }, [fetchMemories])

  async function handleCreate(data: { title: string; category: AIMemoryCategory; content: string; is_enabled: boolean; priority: number }) {
    const res = await fetch('/api/ai/training/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error('Failed to create')
    toast.success('Memory created')
    fetchMemories()
  }

  async function handleUpdate(data: { title: string; category: AIMemoryCategory; content: string; is_enabled: boolean; priority: number }) {
    if (!editingMemory) return
    const res = await fetch(`/api/ai/training/memories/${editingMemory.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error('Failed to update')
    toast.success('Memory updated')
    setEditingMemory(null)
    fetchMemories()
  }

  async function handleToggle(memory: AIMemory) {
    try {
      const res = await fetch(`/api/ai/training/memories/${memory.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: !memory.is_enabled }),
      })
      if (!res.ok) throw new Error('Failed to update')
      setMemories((prev) =>
        prev.map((m) => (m.id === memory.id ? { ...m, is_enabled: !m.is_enabled } : m))
      )
    } catch {
      toast.error('Failed to update memory')
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this memory? This cannot be undone.')) return
    try {
      const res = await fetch(`/api/ai/training/memories/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete')
      toast.success('Memory deleted')
      fetchMemories()
    } catch {
      toast.error('Failed to delete memory')
    }
  }

  const activeCount = memories.filter((m) => m.is_enabled).length

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            {activeCount} active / {memories.length} total memories
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={categoryFilter} onValueChange={(v) => v && setCategoryFilter(v)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="All Categories">
                {categoryFilter === 'all' ? 'All Categories' : CATEGORY_LABELS[categoryFilter as AIMemoryCategory] || categoryFilter}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => { setEditingMemory(null); setDialogOpen(true) }}>
            <Plus className="h-4 w-4 mr-1" />
            Add Memory
          </Button>
        </div>
      </div>

      {/* Memory List */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading memories...</div>
      ) : memories.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Brain className="h-12 w-12 text-muted-foreground/50 mb-3" />
            <h3 className="font-medium text-lg">No training memories yet</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-md">
              Add training instructions to teach your AI how to respond. These get injected into the AI&apos;s system prompt for every conversation.
            </p>
            <Button className="mt-4" onClick={() => { setEditingMemory(null); setDialogOpen(true) }}>
              <Plus className="h-4 w-4 mr-1" />
              Add Your First Memory
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {memories.map((memory) => (
            <Card key={memory.id} className={!memory.is_enabled ? 'opacity-60' : ''}>
              <CardContent className="flex items-start gap-4 py-4">
                <Switch
                  checked={memory.is_enabled}
                  onCheckedChange={() => handleToggle(memory)}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h4 className="font-medium text-sm">{memory.title}</h4>
                    <Badge variant="secondary" className={CATEGORY_COLORS[memory.category]}>
                      {CATEGORY_LABELS[memory.category]}
                    </Badge>
                    {memory.priority > 0 && (
                      <Badge variant="outline" className="text-xs">
                        Priority: {memory.priority}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground line-clamp-2">{memory.content}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditingMemory(memory)
                      setDialogOpen(true)
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(memory.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Form Dialog */}
      <MemoryFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setEditingMemory(null)
        }}
        memory={editingMemory}
        onSave={editingMemory ? handleUpdate : handleCreate}
      />
    </div>
  )
}
