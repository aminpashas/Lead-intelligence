'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Plus, Trash2, Loader2, GripVertical, Clock, MessageSquare, Mail, ListFilter, Users, Send } from 'lucide-react'
import { toast } from 'sonner'
import { aureaFontVars } from '@/lib/fonts'

type Step = {
  step_number: number
  name: string
  channel: 'sms' | 'email'
  delay_minutes: number
  subject: string
  body_template: string
  ai_personalize: boolean
}

// The subset of a campaign the builder needs to pre-fill an edit. Loosely typed
// on the step side because callers hand us raw `campaign_steps` rows.
export type EditingCampaign = {
  id: string
  name: string
  description?: string | null
  type?: string | null
  channel?: string | null
  smart_list_id?: string | null
  target_criteria?: Record<string, unknown> | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  steps?: any[]
}

const DELAY_PRESETS = [
  { label: 'Immediately', value: 0 },
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '4 hours', value: 240 },
  { label: '1 day', value: 1440 },
  { label: '2 days', value: 2880 },
  { label: '3 days', value: 4320 },
  { label: '1 week', value: 10080 },
]

const TEMPLATE_VARS = '{{first_name}}, {{practice_name}}, {{consultation_link}}'

export type PipelineStageOption = { id: string; name: string; slug: string; position: number }

// How a campaign's audience is scoped. A saved Smart List (reusable, rich
// criteria) or an ad-hoc set of pipeline stages (quick, no list to create).
type AudienceMode = 'smart_list' | 'stages'

// Base UI's <SelectValue> renders the raw value, so map each value → trigger label.
const TYPE_LABELS = {
  drip: 'Drip (timed sequence)',
  broadcast: 'Broadcast (one-time blast)',
  trigger: 'Trigger (event-based)',
}
const CHANNEL_LABELS = { sms: 'SMS', email: 'Email' }
const DELAY_LABELS = Object.fromEntries(DELAY_PRESETS.map((d) => [String(d.value), d.label]))

function defaultStep(): Step {
  return {
    step_number: 1,
    name: 'Welcome Message',
    channel: 'sms',
    delay_minutes: 0,
    subject: '',
    body_template:
      'Hi {{first_name}}! Thank you for your interest in All-on-4 dental implants. We specialize in helping patients get a permanent, beautiful smile in just one day. Would you like to schedule a free consultation?',
    ai_personalize: true,
  }
}

export function CampaignBuilder({
  initialSmartListId,
  autoOpen,
  stages = [],
  editingCampaign,
  open: openProp,
  onOpenChange,
}: {
  initialSmartListId?: string
  autoOpen?: boolean
  stages?: PipelineStageOption[]
  editingCampaign?: EditingCampaign | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
} = {}) {
  // Open state: controlled (edit mode, parent owns it) or self-managed (create).
  const [openState, setOpenState] = useState(autoOpen ?? false)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : openState
  const setOpen = (v: boolean) => {
    if (isControlled) onOpenChange?.(v)
    else setOpenState(v)
  }
  const isEditing = !!editingCampaign

  const [saving, setSaving] = useState(false)
  // Index of the step whose "Send test to me" request is in flight (null = none).
  const [testingStep, setTestingStep] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<string>('drip')
  const [channel, setChannel] = useState<string>('multi')
  const [audienceMode, setAudienceMode] = useState<AudienceMode>('smart_list')
  const [smartListId, setSmartListId] = useState<string>(initialSmartListId ?? '')
  const [stageIds, setStageIds] = useState<string[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [smartLists, setSmartLists] = useState<any[]>([])
  const [steps, setSteps] = useState<Step[]>([defaultStep()])
  // Snapshot of the form as it was when the dialog opened; drives the unsaved-
  // changes guard. Empty until the first open.
  const [snapshot, setSnapshot] = useState('')
  const [discardOpen, setDiscardOpen] = useState(false)
  const router = useRouter()

  const currentForm = () =>
    JSON.stringify({ name, description, type, channel, audienceMode, smartListId, stageIds, steps })
  const isDirty = open && snapshot !== '' && currentForm() !== snapshot

  // Populate (or reset) the form whenever the dialog opens. In edit mode we
  // pre-fill from the campaign; in create mode we snapshot the current defaults
  // so the unsaved-changes guard has a baseline.
  useEffect(() => {
    if (!open) return
    loadSmartLists()

    if (editingCampaign) {
      const c = editingCampaign
      const nextSteps: Step[] = (c.steps ?? [])
        .slice()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .sort((a: any, b: any) => (a.step_number ?? 0) - (b.step_number ?? 0))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((s: any, i: number) => ({
          step_number: i + 1,
          name: s.name ?? `Step ${i + 1}`,
          channel: (s.channel as 'sms' | 'email') ?? 'sms',
          delay_minutes: s.delay_minutes ?? 0,
          subject: s.subject ?? '',
          body_template: s.body_template ?? '',
          ai_personalize: s.ai_personalize ?? false,
        }))
      const criteriaStages = Array.isArray(c.target_criteria?.stages)
        ? (c.target_criteria!.stages as string[])
        : []
      const mode: AudienceMode = c.smart_list_id
        ? 'smart_list'
        : criteriaStages.length > 0
          ? 'stages'
          : 'smart_list'
      const resolvedSteps = nextSteps.length > 0 ? nextSteps : [defaultStep()]

      setName(c.name ?? '')
      setDescription(c.description ?? '')
      setType(c.type ?? 'drip')
      setChannel(c.channel ?? 'multi')
      setAudienceMode(mode)
      setSmartListId(c.smart_list_id ?? '')
      setStageIds(criteriaStages)
      setSteps(resolvedSteps)
      setSnapshot(
        JSON.stringify({
          name: c.name ?? '',
          description: c.description ?? '',
          type: c.type ?? 'drip',
          channel: c.channel ?? 'multi',
          audienceMode: mode,
          smartListId: c.smart_list_id ?? '',
          stageIds: criteriaStages,
          steps: resolvedSteps,
        })
      )
    } else {
      // Create mode: baseline is the current (possibly default) form.
      setSnapshot(currentForm())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingCampaign])

  // Fetch Smart Lists when dialog opens
  async function loadSmartLists() {
    try {
      const res = await fetch('/api/smart-lists')
      if (res.ok) {
        const data = await res.json()
        setSmartLists(data.smart_lists || [])
      }
    } catch { /* ignore */ }
  }

  function addStep() {
    setSteps((prev) => [
      ...prev,
      {
        step_number: prev.length + 1,
        name: `Step ${prev.length + 1}`,
        channel: 'sms',
        delay_minutes: 1440,
        subject: '',
        body_template: '',
        ai_personalize: false,
      },
    ])
  }

  function removeStep(index: number) {
    setSteps((prev) => prev.filter((_, i) => i !== index).map((s, i) => ({ ...s, step_number: i + 1 })))
  }

  function updateStep(index: number, updates: Partial<Step>) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...updates } : s)))
  }

  function toggleStage(id: string) {
    setStageIds((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))
  }

  // Send this step to the logged-in staffer's OWN phone/email as a real preview.
  // The route derives the recipient server-side from the authenticated user — the
  // body only carries the step's channel + content, never a recipient — so this
  // can never be aimed at a patient.
  async function sendTest(index: number) {
    const step = steps[index]
    if (!step.body_template.trim()) {
      toast.error('Add message content before sending a test')
      return
    }
    setTestingStep(index)
    try {
      const res = await fetch('/api/campaigns/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: step.channel,
          subject: step.channel === 'email' ? step.subject : undefined,
          body: step.body_template,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data?.error || 'Failed to send test')
        return
      }
      const where = data?.recipient_masked ? ` (${data.recipient_masked})` : ''
      const target = step.channel === 'email' ? 'email' : 'phone'
      if (data?.delivery === 'suppressed') {
        toast.success(`Test accepted — sending is in test mode, so nothing was delivered to your ${target}${where}`)
      } else {
        toast.success(`Test sent to your ${target}${where}`)
      }
    } catch {
      toast.error('Network error — could not send test')
    } finally {
      setTestingStep(null)
    }
  }

  // Intercept close attempts (Cancel, backdrop, ESC, X) to guard unsaved edits.
  function requestOpenChange(next: boolean) {
    if (!next && isDirty) {
      setDiscardOpen(true)
      return
    }
    setOpen(next)
  }

  async function handleSave() {
    if (!name) { toast.error('Campaign name is required'); return }
    if (steps.some((s) => !s.body_template)) { toast.error('All steps need message content'); return }

    // Audience: a Smart List OR a set of pipeline stages. Exactly one is sent so
    // enrollment has a single, unambiguous source (smart_list_id wins server-side).
    const hasSmartList = audienceMode === 'smart_list' && !!smartListId.trim()
    const hasStages = audienceMode === 'stages' && stageIds.length > 0

    setSaving(true)
    try {
      const res = await fetch(
        isEditing ? `/api/campaigns/${editingCampaign!.id}` : '/api/campaigns',
        {
          method: isEditing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            description,
            type,
            channel,
            // On edit, send explicit nulls to clear the other audience mode.
            smart_list_id: hasSmartList ? smartListId : isEditing ? null : undefined,
            target_criteria: hasStages ? { stages: stageIds } : isEditing ? null : undefined,
            steps: steps.map((s) => ({
              ...s,
              subject: s.channel === 'email' ? s.subject : undefined,
            })),
          }),
        }
      )

      if (!res.ok) throw new Error('Failed to save')

      toast.success(isEditing ? 'Campaign updated!' : 'Campaign created!')
      setSnapshot(currentForm()) // clean — no discard prompt on close
      setOpen(false)
      router.refresh()
    } catch {
      toast.error(isEditing ? 'Failed to save campaign' : 'Failed to create campaign')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={requestOpenChange}>
      {!isEditing && (
        <DialogTrigger>
          <span className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer">
            <Plus className="h-4 w-4" />
            New Campaign
          </span>
        </DialogTrigger>
      )}
      <DialogContent className={`aurea ${aureaFontVars} sm:max-w-3xl max-h-[85dvh] overflow-y-auto bg-aurea-surface`}>
        <DialogHeader className="space-y-1">
          <p className="aurea-eyebrow">{isEditing ? 'Edit campaign' : 'New campaign'}</p>
          <DialogTitle
            className="text-[24px] font-normal tracking-[-0.015em] text-aurea-ink"
            style={{ fontFamily: 'var(--font-instrument-serif), "Newsreader", Georgia, serif' }}
          >
            {isEditing ? 'Edit campaign' : 'Create drip campaign'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-6 mt-4">
          {/* Campaign Info */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Campaign Name *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="New Patient Nurture Sequence"
              />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select items={TYPE_LABELS} value={type} onValueChange={(v) => v && setType(v)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="drip">Drip (timed sequence)</SelectItem>
                  <SelectItem value="broadcast">Broadcast (one-time blast)</SelectItem>
                  <SelectItem value="trigger">Trigger (event-based)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Automated follow-up sequence for new implant leads..."
            />
          </div>

          {/* Target Audience — a saved Smart List or a set of pipeline stages */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <ListFilter className="h-4 w-4" />
              Target Audience
            </Label>

            {/* Mode toggle */}
            <div className="inline-flex rounded-md border border-aurea-border p-0.5 text-sm">
              <button
                type="button"
                onClick={() => setAudienceMode('smart_list')}
                className={`rounded px-3 py-1.5 transition-colors ${audienceMode === 'smart_list' ? 'bg-aurea-ink text-aurea-surface' : 'text-aurea-ink-2 hover:text-aurea-ink'}`}
              >
                Smart List
              </button>
              <button
                type="button"
                onClick={() => setAudienceMode('stages')}
                className={`rounded px-3 py-1.5 transition-colors ${audienceMode === 'stages' ? 'bg-aurea-ink text-aurea-surface' : 'text-aurea-ink-2 hover:text-aurea-ink'}`}
              >
                Pipeline stages
              </button>
            </div>

            {audienceMode === 'smart_list' ? (
              <>
                <Select value={smartListId} onValueChange={(v) => setSmartListId(v || '')}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="All leads (no Smart List)">
                      {(value) => smartLists.find((sl: any) => sl.id === value)?.name ?? 'All leads (manual targeting)'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value=" ">All leads (manual targeting)</SelectItem>
                    {smartLists.map((sl: any) => (
                      <SelectItem key={sl.id} value={sl.id}>
                        <span className="flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: sl.color }} />
                          {sl.name}
                          <span className="text-muted-foreground">({sl.lead_count} leads)</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {smartListId && smartListId.trim() && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Users className="h-3 w-3" />
                    Campaign will target leads matching this Smart List&apos;s criteria
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {stages.length === 0 && (
                    <p className="text-xs text-muted-foreground">No pipeline stages found for this account.</p>
                  )}
                  {stages.map((stage) => {
                    const selected = stageIds.includes(stage.id)
                    return (
                      <button
                        key={stage.id}
                        type="button"
                        onClick={() => toggleStage(stage.id)}
                        className={`rounded-full border px-3 py-1 text-xs transition-colors ${selected ? 'border-aurea-ink bg-aurea-ink text-aurea-surface' : 'border-aurea-border text-aurea-ink-2 hover:border-aurea-ink hover:text-aurea-ink'}`}
                      >
                        {stage.name}
                      </button>
                    )
                  })}
                </div>
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  {stageIds.length > 0
                    ? `Campaign will enroll leads currently in ${stageIds.length} selected stage${stageIds.length > 1 ? 's' : ''}`
                    : 'Select one or more stages to enroll leads sitting in them'}
                </p>
              </>
            )}
          </div>

          {/* Steps */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <Label className="text-base font-semibold">Sequence Steps</Label>
              <p className="text-xs text-muted-foreground">
                Variables: {TEMPLATE_VARS}
              </p>
            </div>

            <div className="space-y-3">
              {steps.map((step, index) => (
                <div key={index} className="aurea-card space-y-3 p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <GripVertical className="h-4 w-4 text-aurea-ink-3" />
                        <span className="aurea-eyebrow">Step {step.step_number}</span>
                        <Input
                          value={step.name}
                          onChange={(e) => updateStep(index, { name: e.target.value })}
                          className="w-48 h-8"
                          placeholder="Step name"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        {steps.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Remove step"
                            className="h-8 w-8"
                            onClick={() => removeStep(index)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Channel</Label>
                        <Select
                          items={CHANNEL_LABELS}
                          value={step.channel}
                          onValueChange={(v) => v && updateStep(index, { channel: v as 'sms' | 'email' })}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="sms">
                              <span className="flex items-center gap-1.5">
                                <MessageSquare className="h-3 w-3" /> SMS
                              </span>
                            </SelectItem>
                            <SelectItem value="email">
                              <span className="flex items-center gap-1.5">
                                <Mail className="h-3 w-3" /> Email
                              </span>
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">
                          <Clock className="h-3 w-3 inline mr-1" />
                          Delay
                        </Label>
                        <Select
                          items={DELAY_LABELS}
                          value={String(step.delay_minutes)}
                          onValueChange={(v) => v && updateStep(index, { delay_minutes: parseInt(v) })}
                        >
                          <SelectTrigger className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DELAY_PRESETS.map((d) => (
                              <SelectItem key={d.value} value={String(d.value)}>{d.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-end gap-2">
                        <div className="flex items-center gap-1.5">
                          <Switch
                            checked={step.ai_personalize}
                            onCheckedChange={(v) => updateStep(index, { ai_personalize: v })}
                          />
                          <Label className="text-xs">AI Personalize</Label>
                        </div>
                      </div>
                    </div>

                    {step.channel === 'email' && (
                      <Input
                        value={step.subject}
                        onChange={(e) => updateStep(index, { subject: e.target.value })}
                        placeholder="Email subject line..."
                        className="h-8"
                      />
                    )}

                    <Textarea
                      value={step.body_template}
                      onChange={(e) => updateStep(index, { body_template: e.target.value })}
                      placeholder={step.channel === 'sms' ? 'SMS message (160 chars ideal)...' : 'Email body...'}
                      rows={step.channel === 'sms' ? 3 : 5}
                    />

                    <div className="mt-2 flex items-center justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1.5 text-aurea-ink-3"
                        onClick={() => sendTest(index)}
                        disabled={testingStep !== null}
                        title="Sends this step to your own phone/email as a preview — never to a patient"
                      >
                        {testingStep === index ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Send className="h-3.5 w-3.5" />
                        )}
                        Send test to me
                      </Button>
                    </div>
                </div>
              ))}
            </div>

            <Button variant="outline" className="w-full mt-3 gap-1.5" onClick={addStep}>
              <Plus className="h-4 w-4" /> Add Step
            </Button>
          </div>

          {/* Save */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button variant="outline" onClick={() => requestOpenChange(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="gap-1.5">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {isEditing ? 'Save changes' : 'Create Campaign'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      open={discardOpen}
      onOpenChange={setDiscardOpen}
      title="Discard changes?"
      description="You have unsaved changes. Closing now will lose them."
      confirmLabel="Discard"
      cancelLabel="Keep editing"
      destructive
      onConfirm={() => setOpen(false)}
    />
    </>
  )
}
