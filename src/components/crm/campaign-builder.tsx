'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
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
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Plus, Trash2, Loader2, GripVertical, Clock, MessageSquare, Mail, ListFilter, Users } from 'lucide-react'
import { toast } from 'sonner'

type Step = {
  step_number: number
  name: string
  channel: 'sms' | 'email'
  delay_minutes: number
  subject: string
  body_template: string
  ai_personalize: boolean
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

export function CampaignBuilder() {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<string>('drip')
  const [channel, setChannel] = useState<string>('multi')
  const [smartListId, setSmartListId] = useState<string>('')
  const [smartLists, setSmartLists] = useState<any[]>([])
  const [steps, setSteps] = useState<Step[]>([
    {
      step_number: 1,
      name: 'Welcome Message',
      channel: 'sms',
      delay_minutes: 0,
      subject: '',
      body_template: 'Hi {{first_name}}! Thank you for your interest in All-on-4 dental implants. We specialize in helping patients get a permanent, beautiful smile in just one day. Would you like to schedule a free consultation?',
      ai_personalize: true,
    },
  ])
  const router = useRouter()

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

  async function handleSave() {
    if (!name) { toast.error('Campaign name is required'); return }
    if (steps.some((s) => !s.body_template)) { toast.error('All steps need message content'); return }

    setSaving(true)
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          type,
          channel,
          smart_list_id: smartListId || undefined,
          steps: steps.map((s) => ({
            ...s,
            subject: s.channel === 'email' ? s.subject : undefined,
          })),
        }),
      })

      if (!res.ok) throw new Error('Failed to create')

      toast.success('Campaign created!')
      setOpen(false)
      router.refresh()
    } catch {
      toast.error('Failed to create campaign')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) loadSmartLists() }}>
      <DialogTrigger>
        <span className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer">
          <Plus className="h-4 w-4" />
          New Campaign
        </span>
      </DialogTrigger>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Drip Campaign</DialogTitle>
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
              <Select value={type} onValueChange={(v) => v && setType(v)}>
                <SelectTrigger>
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

          {/* Target Audience */}
          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <ListFilter className="h-4 w-4" />
              Target Audience (Smart List)
            </Label>
            <Select value={smartListId} onValueChange={(v) => setSmartListId(v || '')}>
              <SelectTrigger>
                <SelectValue placeholder="All leads (no Smart List)" />
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
                <Card key={index}>
                  <CardContent className="py-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <GripVertical className="h-4 w-4 text-muted-foreground" />
                        <Badge variant="outline">Step {step.step_number}</Badge>
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
                  </CardContent>
                </Card>
              ))}
            </div>

            <Button variant="outline" className="w-full mt-3 gap-1.5" onClick={addStep}>
              <Plus className="h-4 w-4" /> Add Step
            </Button>
          </div>

          {/* Save */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="gap-1.5">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Campaign
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
