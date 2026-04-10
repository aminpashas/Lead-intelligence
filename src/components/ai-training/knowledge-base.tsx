'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Plus, Pencil, Trash2, BookOpen, Search, Download, Loader2 } from 'lucide-react'
import { KnowledgeFormDialog } from './knowledge-form-dialog'
import type { AIKnowledgeArticle, AIKnowledgeCategory } from '@/types/database'
import { toast } from 'sonner'

const CATEGORY_LABELS: Record<AIKnowledgeCategory, string> = {
  procedures: 'Procedures',
  pricing: 'Pricing',
  faqs: 'FAQs',
  aftercare: 'Aftercare',
  financing: 'Financing',
  general: 'General',
}

const CATEGORY_COLORS: Record<AIKnowledgeCategory, string> = {
  procedures: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  pricing: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  faqs: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  aftercare: 'bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300',
  financing: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  general: 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300',
}

export function KnowledgeBase() {
  const [articles, setArticles] = useState<AIKnowledgeArticle[]>([])
  const [loading, setLoading] = useState(true)
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingArticle, setEditingArticle] = useState<AIKnowledgeArticle | null>(null)
  const [seeding, setSeeding] = useState(false)

  const fetchArticles = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (categoryFilter !== 'all') params.set('category', categoryFilter)
      if (searchQuery) params.set('search', searchQuery)
      const url = `/api/ai/training/knowledge${params.toString() ? '?' + params.toString() : ''}`
      const res = await fetch(url)
      const data = await res.json()
      setArticles(data.articles || [])
    } catch {
      toast.error('Failed to load articles')
    } finally {
      setLoading(false)
    }
  }, [categoryFilter, searchQuery])

  useEffect(() => {
    fetchArticles()
  }, [fetchArticles])

  async function handleCreate(data: { title: string; category: AIKnowledgeCategory; content: string; tags: string[]; is_enabled: boolean }) {
    const res = await fetch('/api/ai/training/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error('Failed to create')
    toast.success('Article created')
    fetchArticles()
  }

  async function handleUpdate(data: { title: string; category: AIKnowledgeCategory; content: string; tags: string[]; is_enabled: boolean }) {
    if (!editingArticle) return
    const res = await fetch(`/api/ai/training/knowledge/${editingArticle.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) throw new Error('Failed to update')
    toast.success('Article updated')
    setEditingArticle(null)
    fetchArticles()
  }

  async function handleToggle(article: AIKnowledgeArticle) {
    await fetch(`/api/ai/training/knowledge/${article.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_enabled: !article.is_enabled }),
    })
    setArticles((prev) =>
      prev.map((a) => (a.id === article.id ? { ...a, is_enabled: !a.is_enabled } : a))
    )
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this article? This cannot be undone.')) return
    await fetch(`/api/ai/training/knowledge/${id}`, { method: 'DELETE' })
    toast.success('Article deleted')
    fetchArticles()
  }

  async function handleSeedFAQs() {
    if (!confirm('This will load 200 sample dental implant FAQs into your knowledge base. Continue?')) return
    setSeeding(true)
    try {
      const res = await fetch('/api/ai/training/knowledge/seed', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to load FAQs')
        return
      }
      toast.success(data.message)
      fetchArticles()
    } catch {
      toast.error('Failed to load FAQs')
    } finally {
      setSeeding(false)
    }
  }

  const enabledCount = articles.filter((a) => a.is_enabled).length

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-muted-foreground">
          {enabledCount} active / {articles.length} total articles
        </p>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search articles..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && fetchArticles()}
              className="pl-9 w-[200px]"
            />
          </div>
          <Select value={categoryFilter} onValueChange={(v) => v && setCategoryFilter(v)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All Categories">
                {categoryFilter === 'all' ? 'All Categories' : CATEGORY_LABELS[categoryFilter as AIKnowledgeCategory] || categoryFilter}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => { setEditingArticle(null); setDialogOpen(true) }}>
            <Plus className="h-4 w-4 mr-1" />
            Add Article
          </Button>
        </div>
      </div>

      {/* Articles List */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading articles...</div>
      ) : articles.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <BookOpen className="h-12 w-12 text-muted-foreground/50 mb-3" />
            <h3 className="font-medium text-lg">No knowledge articles yet</h3>
            <p className="text-sm text-muted-foreground mt-1 max-w-md">
              Add articles about your procedures, pricing, FAQs, and more. The AI will reference these when responding to conversations.
            </p>
            <div className="flex gap-3 mt-4">
              <Button onClick={() => { setEditingArticle(null); setDialogOpen(true) }}>
                <Plus className="h-4 w-4 mr-1" />
                Add Your First Article
              </Button>
              <Button variant="outline" onClick={handleSeedFAQs} disabled={seeding}>
                {seeding ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
                {seeding ? 'Loading...' : 'Load 200 Sample FAQs'}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {articles.map((article) => (
            <Card key={article.id} className={!article.is_enabled ? 'opacity-60' : ''}>
              <CardContent className="py-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Switch
                      checked={article.is_enabled}
                      onCheckedChange={() => handleToggle(article)}
                    />
                    <h4 className="font-medium text-sm truncate">{article.title}</h4>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditingArticle(article)
                        setDialogOpen(true)
                      }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(article.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <Badge variant="secondary" className={CATEGORY_COLORS[article.category]}>
                    {CATEGORY_LABELS[article.category]}
                  </Badge>
                  {article.tags.slice(0, 3).map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                  {article.tags.length > 3 && (
                    <span className="text-xs text-muted-foreground">+{article.tags.length - 3}</span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground line-clamp-3">{article.content}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Form Dialog */}
      <KnowledgeFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setEditingArticle(null)
        }}
        article={editingArticle}
        onSave={editingArticle ? handleUpdate : handleCreate}
      />
    </div>
  )
}
