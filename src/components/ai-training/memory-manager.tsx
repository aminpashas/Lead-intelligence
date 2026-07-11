'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
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
  tone_and_style: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
  product_knowledge: 'bg-aurea-primary/10 text-aurea-primary border border-aurea-primary/20',
  objection_handling: 'bg-aurea-amber/10 text-aurea-amber border border-aurea-amber/20',
  pricing_rules: 'bg-aurea-gold/10 text-aurea-gold border border-aurea-gold/20',
  compliance_rules: 'bg-aurea-rose/10 text-aurea-rose border border-aurea-rose/20',
  general: 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border',
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
          <p className="font-mono text-[12px] tabular-nums text-aurea-ink-3">
            {activeCount} active / {memories.length} total memories
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select items={{ all: 'All Categories', ...CATEGORY_LABELS }} value={categoryFilter} onValueChange={(v) => v && setCategoryFilter(v)}>
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
        <div className="py-12 text-center text-[13px] text-aurea-ink-3">Loading memories...</div>
      ) : memories.length === 0 ? (
        <div className="aurea-card">
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Brain className="h-10 w-10 text-aurea-ink-3/40 mb-3" strokeWidth={1.75} />
            <h3 className="aurea-display text-[18px] text-aurea-ink">No training memories yet</h3>
            <p className="mt-1 max-w-md text-[13px] text-aurea-ink-3">
              Add training instructions to teach your AI how to respond. These get injected into the AI&apos;s system prompt for every conversation.
            </p>
            <Button className="mt-4" onClick={() => { setEditingMemory(null); setDialogOpen(true) }}>
              <Plus className="h-4 w-4 mr-1" />
              Add Your First Memory
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {memories.map((memory) => (
            <div key={memory.id} className={`aurea-card flex items-start gap-4 p-4${!memory.is_enabled ? ' opacity-60' : ''}`}>
              <Switch
                checked={memory.is_enabled}
                onCheckedChange={() => handleToggle(memory)}
                className="mt-1"
              />
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <h4 className="text-[14px] font-medium text-aurea-ink">{memory.title}</h4>
                  <span className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium ${CATEGORY_COLORS[memory.category]}`}>
                    {CATEGORY_LABELS[memory.category]}
                  </span>
                  {memory.priority > 0 && (
                    <span className="inline-flex items-center rounded border border-aurea-border px-2 py-0.5 font-mono text-[11px] tabular-nums text-aurea-ink-3">
                      Priority: {memory.priority}
                    </span>
                  )}
                </div>
                <p className="text-[13px] text-aurea-ink-2 line-clamp-2">{memory.content}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditingMemory(memory)
                    setDialogOpen(true)
                  }}
                >
                  <Pencil className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(memory.id)}>
                  <Trash2 className="h-4 w-4 text-aurea-rose" strokeWidth={1.75} />
                </Button>
              </div>
            </div>
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
