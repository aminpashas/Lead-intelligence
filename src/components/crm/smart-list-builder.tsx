'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { TagSelector } from './tag-selector'
import {
  Plus, Trash2, Loader2, Users, Sparkles, Filter, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { SmartListCriteria, PipelineStage, Tag } from '@/types/database'

interface SmartListBuilderProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialValues?: {
    id?: string
    name: string
    description: string
    color: string
    criteria: SmartListCriteria
    is_pinned: boolean
  }
  stages?: PipelineStage[]
  tags?: Tag[]
  onSaved?: () => void
}

const COLORS = [
  '#EF4444', '#F97316', '#F59E0B', '#22C55E', '#10B981',
  '#06B6D4', '#3B82F6', '#6366F1', '#8B5CF6', '#EC4899',
]

const STATUS_OPTIONS = [
  'new', 'contacted', 'qualified', 'consultation_scheduled',
  'consultation_completed', 'treatment_presented', 'financing',
  'contract_sent', 'contract_signed', 'scheduled', 'in_treatment',
  'completed', 'lost', 'disqualified', 'no_show', 'unresponsive',
]

const QUALIFICATION_OPTIONS = ['hot', 'warm', 'cold', 'unqualified']

const SOURCE_TYPE_OPTIONS = [
  'google_ads', 'meta_ads', 'website_form', 'landing_page',
  'referral', 'walk_in', 'phone', 'email_campaign', 'sms_campaign', 'other',
]

export function SmartListBuilder({
  open,
  onOpenChange,
  initialValues,
  stages = [],
  tags: availableTags,
  onSaved,
}: SmartListBuilderProps) {
  const [saving, setSaving] = useState(false)
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  // Form state
  const [name, setName] = useState(initialValues?.name || '')
  const [description, setDescription] = useState(initialValues?.description || '')
  const [color, setColor] = useState(initialValues?.color || '#6366F1')
  const [isPinned, setIsPinned] = useState(initialValues?.is_pinned || false)

  // Criteria state
  const [tagIds, setTagIds] = useState<string[]>(initialValues?.criteria.tags?.ids || [])
  const [tagOperator, setTagOperator] = useState<'and' | 'or'>(initialValues?.criteria.tags?.operator || 'or')
  const [statuses, setStatuses] = useState<string[]>(initialValues?.criteria.statuses || [])
  const [qualifications, setQualifications] = useState<string[]>(initialValues?.criteria.ai_qualifications || [])
  const [scoreRange, setScoreRange] = useState<[number, number]>([
    initialValues?.criteria.score_min ?? 0,
    initialValues?.criteria.score_max ?? 100,
  ])
  const [stageIds, setStageIds] = useState<string[]>(initialValues?.criteria.stages || [])
  const [sourceTypes, setSourceTypes] = useState<string[]>(initialValues?.criteria.source_types || [])
  const [hasPhone, setHasPhone] = useState(initialValues?.criteria.has_phone ?? false)
  const [hasEmail, setHasEmail] = useState(initialValues?.criteria.has_email ?? false)
  const [smsConsent, setSmsConsent] = useState(initialValues?.criteria.sms_consent ?? false)

  function buildCriteria(): SmartListCriteria {
    const criteria: SmartListCriteria = {}
    if (tagIds.length > 0) criteria.tags = { ids: tagIds, operator: tagOperator }
    if (statuses.length > 0) criteria.statuses = statuses
    if (qualifications.length > 0) criteria.ai_qualifications = qualifications
    if (scoreRange[0] > 0) criteria.score_min = scoreRange[0]
    if (scoreRange[1] < 100) criteria.score_max = scoreRange[1]
    if (stageIds.length > 0) criteria.stages = stageIds
    if (sourceTypes.length > 0) criteria.source_types = sourceTypes
    if (hasPhone) criteria.has_phone = true
    if (hasEmail) criteria.has_email = true
    if (smsConsent) criteria.sms_consent = true
    return criteria
  }

  const refreshPreview = useCallback(async () => {
    setPreviewLoading(true)
    try {
      // Use the smart list leads count endpoint via a POST to /api/smart-lists with countOnly
      // For preview, we'll use a simplified approach
      const criteria = buildCriteria()
      const res = await fetch('/api/smart-lists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: '__preview__',
          criteria,
          color,
        }),
      })
      if (res.ok) {
        const { smart_list } = await res.json()
        setPreviewCount(smart_list.lead_count)
        // Delete the preview list
        await fetch(`/api/smart-lists/${smart_list.id}`, { method: 'DELETE' })
      }
    } catch {
      // Ignore preview errors
    } finally {
      setPreviewLoading(false)
    }
  }, [tagIds, statuses, qualifications, scoreRange, stageIds, sourceTypes, hasPhone, hasEmail, smsConsent, tagOperator, color])

  function toggleArrayValue(arr: string[], val: string, setter: (v: string[]) => void) {
    if (arr.includes(val)) {
      setter(arr.filter((v) => v !== val))
    } else {
      setter([...arr, val])
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }

    setSaving(true)
    try {
      const criteria = buildCriteria()
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        color,
        criteria,
        is_pinned: isPinned,
      }

      const url = initialValues?.id
        ? `/api/smart-lists/${initialValues.id}`
        : '/api/smart-lists'
      const method = initialValues?.id ? 'PATCH' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (res.ok) {
        toast.success(initialValues?.id ? 'Smart List updated' : 'Smart List created')
        onOpenChange(false)
        onSaved?.()
      } else {
        const err = await res.json()
        toast.error(err.error || 'Failed to save')
      }
    } finally {
      setSaving(false)
    }
  }

  const hasCriteria = tagIds.length > 0 || statuses.length > 0 || qualifications.length > 0 ||
    scoreRange[0] > 0 || scoreRange[1] < 100 || stageIds.length > 0 ||
    sourceTypes.length > 0 || hasPhone || hasEmail || smsConsent

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            {initialValues?.id ? 'Edit Smart List' : 'Create Smart List'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 mt-2">
          {/* Basic Info */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Hot Leads Ready to Close"
              />
            </div>
            <div className="space-y-2">
              <Label>Color</Label>
              <div className="flex items-center gap-1.5">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setColor(c)}
                    className={cn(
                      'h-6 w-6 rounded-full transition-all',
                      color === c && 'ring-2 ring-offset-1 ring-primary scale-110'
                    )}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this list is for..."
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch checked={isPinned} onCheckedChange={setIsPinned} />
            <Label className="text-sm">Pin to top of Smart Lists</Label>
          </div>

          {/* Criteria Builder */}
          <div className="space-y-4 pt-4 border-t">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-primary" />
              <Label className="text-base font-semibold">Filter Criteria</Label>
            </div>

            {/* Tags Filter */}
            <div className="space-y-2">
              <Label className="text-sm">Tags</Label>
              <div className="flex items-center gap-2">
                <TagSelector
                  selectedTagIds={tagIds}
                  onTagsChange={setTagIds}
                  availableTags={availableTags}
                  className="flex-1"
                />
                {tagIds.length > 1 && (
                  <Select value={tagOperator} onValueChange={(v) => setTagOperator(v as 'and' | 'or')}>
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="or">Any (OR)</SelectItem>
                      <SelectItem value="and">All (AND)</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            {/* AI Qualification */}
            <div className="space-y-2">
              <Label className="text-sm">AI Qualification</Label>
              <div className="flex flex-wrap gap-1.5">
                {QUALIFICATION_OPTIONS.map((q) => (
                  <Badge
                    key={q}
                    variant={qualifications.includes(q) ? 'default' : 'outline'}
                    className="cursor-pointer capitalize"
                    onClick={() => toggleArrayValue(qualifications, q, setQualifications)}
                  >
                    {q}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Score Range */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm">AI Score Range</Label>
                <span className="text-xs text-muted-foreground">{scoreRange[0]} – {scoreRange[1]}</span>
              </div>
              <Slider
                value={scoreRange}
                onValueChange={(v) => setScoreRange(v as [number, number])}
                min={0}
                max={100}
                step={5}
              />
            </div>

            {/* Status */}
            <div className="space-y-2">
              <Label className="text-sm">Lead Status</Label>
              <div className="flex flex-wrap gap-1.5">
                {STATUS_OPTIONS.map((s) => (
                  <Badge
                    key={s}
                    variant={statuses.includes(s) ? 'default' : 'outline'}
                    className="cursor-pointer text-xs capitalize"
                    onClick={() => toggleArrayValue(statuses, s, setStatuses)}
                  >
                    {s.replace(/_/g, ' ')}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Pipeline Stage */}
            {stages.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm">Pipeline Stage</Label>
                <div className="flex flex-wrap gap-1.5">
                  {stages.map((stage) => (
                    <Badge
                      key={stage.id}
                      variant={stageIds.includes(stage.id) ? 'default' : 'outline'}
                      className="cursor-pointer text-xs gap-1"
                      onClick={() => toggleArrayValue(stageIds, stage.id, setStageIds)}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: stage.color }} />
                      {stage.name}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Source Type */}
            <div className="space-y-2">
              <Label className="text-sm">Source Type</Label>
              <div className="flex flex-wrap gap-1.5">
                {SOURCE_TYPE_OPTIONS.map((s) => (
                  <Badge
                    key={s}
                    variant={sourceTypes.includes(s) ? 'default' : 'outline'}
                    className="cursor-pointer text-xs capitalize"
                    onClick={() => toggleArrayValue(sourceTypes, s, setSourceTypes)}
                  >
                    {s.replace(/_/g, ' ')}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Contact info toggles */}
            <div className="grid grid-cols-3 gap-3">
              <div className="flex items-center gap-2">
                <Switch checked={hasPhone} onCheckedChange={setHasPhone} />
                <Label className="text-sm">Has Phone</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={hasEmail} onCheckedChange={setHasEmail} />
                <Label className="text-sm">Has Email</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={smsConsent} onCheckedChange={setSmsConsent} />
                <Label className="text-sm">SMS Consent</Label>
              </div>
            </div>
          </div>

          {/* Preview & Actions */}
          <div className="flex items-center justify-between pt-4 border-t">
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={refreshPreview}
                disabled={previewLoading || !hasCriteria}
                className="gap-1.5"
              >
                {previewLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Users className="h-4 w-4" />
                )}
                Preview Count
              </Button>
              {previewCount !== null && (
                <span className="text-sm font-medium">
                  {previewCount.toLocaleString()} leads match
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving} className="gap-1.5">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {initialValues?.id ? 'Update' : 'Create'} Smart List
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
