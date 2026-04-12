'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ArrowLeft, ArrowRight, Check, Loader2, Plus, Trash2,
  GripVertical, Clock, MessageSquare, Mail, Gift,
  Sparkles, Zap, Target, RefreshCw,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  GOAL_OPTIONS,
  TONE_OPTIONS,
  HOOK_STRATEGY_OPTIONS,
  REACTIVATION_TEMPLATES,
} from '@/lib/campaigns/reactivation-templates'
import type { ReactivationGoal, ReactivationTone, ReactivationHookStrategy, ReactivationOfferType } from '@/types/database'

const DELAY_PRESETS = [
  { label: 'Immediately', value: 0 },
  { label: '30 minutes', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '2 hours', value: 120 },
  { label: '4 hours', value: 240 },
  { label: '1 day', value: 1440 },
  { label: '2 days', value: 2880 },
  { label: '3 days', value: 4320 },
  { label: '5 days', value: 7200 },
  { label: '1 week', value: 10080 },
  { label: '2 weeks', value: 20160 },
  { label: '1 month', value: 43200 },
]

type StepDraft = {
  step_number: number
  name: string
  channel: 'sms' | 'email'
  delay_minutes: number
  subject: string
  body_template: string
  ai_personalize: boolean
}

type OfferDraft = {
  name: string
  description: string
  type: ReactivationOfferType
  value: number
  expiry_date: string
}

type BuilderStep = 'setup' | 'offers' | 'hooks' | 'sequence' | 'review'

const BUILDER_STEPS: { id: BuilderStep; label: string; icon: typeof Target }[] = [
  { id: 'setup', label: 'Setup', icon: Target },
  { id: 'offers', label: 'Offers', icon: Gift },
  { id: 'hooks', label: 'AI Hooks', icon: Sparkles },
  { id: 'sequence', label: 'Sequence', icon: Clock },
  { id: 'review', label: 'Review', icon: Check },
]

export function ReactivationBuilder({ onBack }: { onBack: () => void }) {
  const router = useRouter()
  const [currentStep, setCurrentStep] = useState<BuilderStep>('setup')
  const [saving, setSaving] = useState(false)

  // Step 1: Setup
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [goal, setGoal] = useState<ReactivationGoal>('re_engage')
  const [tone, setTone] = useState<ReactivationTone>('empathetic')
  const [channel, setChannel] = useState<'sms' | 'email' | 'multi'>('multi')
  const [templateId, setTemplateId] = useState<string | null>(null)

  // Step 2: Offers
  const [offers, setOffers] = useState<OfferDraft[]>([])

  // Step 3: Hooks
  const [hooks, setHooks] = useState<Array<{ strategy: ReactivationHookStrategy; enabled: boolean; custom_text: string }>>([
    { strategy: 'empathy', enabled: true, custom_text: '' },
    { strategy: 'special_pricing', enabled: true, custom_text: '' },
    { strategy: 'urgency', enabled: false, custom_text: '' },
    { strategy: 'social_proof', enabled: false, custom_text: '' },
    { strategy: 'new_technology', enabled: false, custom_text: '' },
    { strategy: 'personalized_value', enabled: false, custom_text: '' },
  ])

  // Step 4: Sequence
  const [steps, setSteps] = useState<StepDraft[]>([
    {
      step_number: 1,
      name: 'Welcome Back SMS',
      channel: 'sms',
      delay_minutes: 0,
      subject: '',
      body_template: 'Hi {{first_name}}! It\'s been a while since we connected about your smile journey. We\'ve got some exciting updates at {{practice_name}} — would love to share them with you. Interested? Just text back YES 😊',
      ai_personalize: false,
    },
  ])

  // Engagement rules
  const [maxAttempts, setMaxAttempts] = useState(5)
  const [cooldownDays, setCooldownDays] = useState(3)
  const [stopOnReply, setStopOnReply] = useState(true)
  const [transitionToLive, setTransitionToLive] = useState(true)

  function applyTemplate(id: string) {
    const t = REACTIVATION_TEMPLATES.find(tmpl => tmpl.id === id)
    if (!t) return

    setTemplateId(id)
    setName(t.name)
    setDescription(t.description)
    setGoal(t.goal)
    setTone(t.tone)
    setChannel(t.channel)
    setHooks(HOOK_STRATEGY_OPTIONS.map(h => ({
      strategy: h.id,
      enabled: t.hooks.includes(h.id),
      custom_text: '',
    })))
    setOffers(t.default_offers.map(o => ({
      name: o.name,
      description: o.description || '',
      type: o.type,
      value: o.value,
      expiry_date: '',
    })))
    setSteps(t.steps.map(s => ({
      step_number: s.step_number,
      name: s.name,
      channel: s.channel,
      delay_minutes: s.delay_minutes,
      subject: s.subject || '',
      body_template: s.body_template,
      ai_personalize: s.ai_personalize,
    })))
    setMaxAttempts(t.engagement_rules.max_attempts)
    setCooldownDays(t.engagement_rules.cooldown_days)
    setStopOnReply(t.engagement_rules.stop_on_reply)
    setTransitionToLive(t.engagement_rules.transition_to_live)

    toast.success(`Template "${t.name}" applied!`)
  }

  function addOffer() {
    setOffers(prev => [...prev, { name: '', description: '', type: 'percentage_off', value: 0, expiry_date: '' }])
  }

  function removeOffer(i: number) {
    setOffers(prev => prev.filter((_, idx) => idx !== i))
  }

  function updateOffer(i: number, updates: Partial<OfferDraft>) {
    setOffers(prev => prev.map((o, idx) => idx === i ? { ...o, ...updates } : o))
  }

  function addSequenceStep() {
    setSteps(prev => [...prev, {
      step_number: prev.length + 1,
      name: `Step ${prev.length + 1}`,
      channel: 'sms',
      delay_minutes: 1440,
      subject: '',
      body_template: '',
      ai_personalize: true,
    }])
  }

  function removeSequenceStep(i: number) {
    setSteps(prev => prev.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step_number: idx + 1 })))
  }

  function updateSequenceStep(i: number, updates: Partial<StepDraft>) {
    setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...updates } : s))
  }

  const stepIndex = BUILDER_STEPS.findIndex(s => s.id === currentStep)
  function nextStep() {
    if (stepIndex < BUILDER_STEPS.length - 1) {
      setCurrentStep(BUILDER_STEPS[stepIndex + 1].id)
    }
  }
  function prevStep() {
    if (stepIndex > 0) {
      setCurrentStep(BUILDER_STEPS[stepIndex - 1].id)
    }
  }

  async function handleSave() {
    if (!name) { toast.error('Campaign name is required'); return }
    if (steps.length === 0) { toast.error('At least one sequence step is required'); return }

    setSaving(true)
    try {
      const res = await fetch('/api/reactivation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description,
          goal,
          tone,
          channel,
          ai_hooks: hooks.map(h => ({ strategy: h.strategy, enabled: h.enabled, custom_text: h.custom_text || null })),
          engagement_rules: {
            max_attempts: maxAttempts,
            cooldown_days: cooldownDays,
            escalation_strategy: 'vary_channel',
            stop_on_reply: stopOnReply,
            transition_to_live: transitionToLive,
          },
          offers: offers.filter(o => o.name).map(o => ({
            name: o.name,
            description: o.description,
            type: o.type,
            value: o.value,
            expiry_date: o.expiry_date || undefined,
          })),
          steps: steps.map(s => ({
            step_number: s.step_number,
            name: s.name,
            channel: s.channel,
            delay_minutes: s.delay_minutes,
            subject: s.channel === 'email' ? s.subject : undefined,
            body_template: s.body_template || (s.ai_personalize ? '[AI Generated]' : ''),
            ai_personalize: s.ai_personalize,
            exit_condition: stopOnReply ? { if_replied: true } : undefined,
          })),
        }),
      })

      if (!res.ok) throw new Error('Failed')
      toast.success('Reactivation campaign created! Upload leads or activate it.')
      onBack()
      router.refresh()
    } catch {
      toast.error('Failed to create campaign')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6" id="reactivation-builder">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold">Create Reactivation Campaign</h1>
          <p className="text-sm text-muted-foreground">Build a custom campaign to re-engage dormant leads</p>
        </div>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-center gap-2">
        {BUILDER_STEPS.map((step, i) => {
          const isActive = step.id === currentStep
          const isPast = i < stepIndex
          const StepIcon = step.icon
          return (
            <div key={step.id} className="flex items-center gap-2">
              <button
                onClick={() => setCurrentStep(step.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-purple-100 text-purple-700 shadow-sm'
                    : isPast
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'text-muted-foreground hover:bg-accent'
                }`}
              >
                {isPast ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <StepIcon className="h-4 w-4" />
                )}
                <span className="hidden sm:inline">{step.label}</span>
              </button>
              {i < BUILDER_STEPS.length - 1 && (
                <div className={`w-6 h-px ${isPast ? 'bg-emerald-300' : 'bg-border'}`} />
              )}
            </div>
          )
        })}
      </div>

      {/* ─── Step 1: Setup ─────────────────── */}
      {currentStep === 'setup' && (
        <div className="space-y-6">
          {/* Template Quick-Apply */}
          <Card>
            <CardContent className="pt-5">
              <Label className="text-sm font-semibold mb-3 block">Start from a Template (optional)</Label>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {REACTIVATION_TEMPLATES.map(t => (
                  <button
                    key={t.id}
                    onClick={() => applyTemplate(t.id)}
                    className={`p-3 rounded-lg border text-left transition-all text-sm ${
                      templateId === t.id
                        ? 'border-purple-400 bg-purple-50 ring-1 ring-purple-200'
                        : 'hover:border-purple-200 hover:bg-purple-50/50'
                    }`}
                  >
                    <p className="font-medium text-xs">{t.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{t.description}</p>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardContent className="pt-5 space-y-4">
                <div className="space-y-2">
                  <Label>Campaign Name *</Label>
                  <Input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="Spring Database Revival"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Textarea
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="Re-engage leads from our Q1 database..."
                    rows={3}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5 space-y-4">
                <div className="space-y-2">
                  <Label>Goal</Label>
                  <Select value={goal} onValueChange={v => v && setGoal(v as ReactivationGoal)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {GOAL_OPTIONS.map(g => (
                        <SelectItem key={g.id} value={g.id}>
                          <div>
                            <span className="font-medium">{g.label}</span>
                            <span className="text-xs text-muted-foreground ml-2">{g.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>AI Tone</Label>
                  <Select value={tone} onValueChange={v => v && setTone(v as ReactivationTone)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TONE_OPTIONS.map(t => (
                        <SelectItem key={t.id} value={t.id}>{t.label} — {t.description}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Channel</Label>
                  <Select value={channel} onValueChange={v => v && setChannel(v as 'sms' | 'email' | 'multi')}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="multi">Multi-Channel (SMS + Email)</SelectItem>
                      <SelectItem value="sms">SMS Only</SelectItem>
                      <SelectItem value="email">Email Only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ─── Step 2: Offers ────────────────── */}
      {currentStep === 'offers' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">Offers & Incentives</h3>
              <p className="text-sm text-muted-foreground">Add promos to incentivize re-engagement (optional)</p>
            </div>
            <Button variant="outline" size="sm" onClick={addOffer} className="gap-1.5">
              <Plus className="h-4 w-4" /> Add Offer
            </Button>
          </div>

          {offers.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center py-10">
                <Gift className="h-10 w-10 text-muted-foreground mb-3" />
                <p className="font-medium mb-1">No offers yet</p>
                <p className="text-sm text-muted-foreground mb-4">Offers increase re-engagement by 3-5x</p>
                <Button variant="outline" size="sm" onClick={addOffer} className="gap-1.5">
                  <Plus className="h-4 w-4" /> Add Your First Offer
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {offers.map((offer, i) => (
                <Card key={i}>
                  <CardContent className="pt-4 space-y-3">
                    <div className="flex items-start justify-between">
                      <Badge variant="outline" className="text-xs gap-1">
                        <Gift className="h-3 w-3 text-pink-500" />
                        Offer {i + 1}
                      </Badge>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeOffer(i)}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Offer Name *</Label>
                        <Input
                          value={offer.name}
                          onChange={e => updateOffer(i, { name: e.target.value })}
                          placeholder="Free 3D CT Scan"
                          className="h-9"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Type</Label>
                        <Select value={offer.type} onValueChange={v => v && updateOffer(i, { type: v as ReactivationOfferType })}>
                          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="percentage_off">Percentage Off</SelectItem>
                            <SelectItem value="dollar_off">Dollar Amount Off</SelectItem>
                            <SelectItem value="free_addon">Free Add-On</SelectItem>
                            <SelectItem value="financing_special">Financing Special</SelectItem>
                            <SelectItem value="limited_time">Limited Time Offer</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Value ({offer.type === 'percentage_off' ? '%' : '$'})</Label>
                        <Input
                          type="number"
                          value={offer.value || ''}
                          onChange={e => updateOffer(i, { value: parseFloat(e.target.value) || 0 })}
                          placeholder={offer.type === 'percentage_off' ? '15' : '500'}
                          className="h-9"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Expiry Date (optional)</Label>
                        <Input
                          type="date"
                          value={offer.expiry_date}
                          onChange={e => updateOffer(i, { expiry_date: e.target.value })}
                          className="h-9"
                        />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">Description</Label>
                      <Input
                        value={offer.description}
                        onChange={e => updateOffer(i, { description: e.target.value })}
                        placeholder="Complimentary 3D CT scan ($500+ value) with consultation..."
                        className="h-9"
                      />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── Step 3: AI Hooks ──────────────── */}
      {currentStep === 'hooks' && (
        <div className="space-y-4">
          <div>
            <h3 className="font-semibold">AI Hook Strategies</h3>
            <p className="text-sm text-muted-foreground">Select the engagement angles AI should use when crafting messages</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {hooks.map((hook, i) => {
              const option = HOOK_STRATEGY_OPTIONS.find(h => h.id === hook.strategy)
              if (!option) return null

              return (
                <Card key={hook.strategy} className={`transition-all ${hook.enabled ? 'border-purple-300 bg-purple-50/30' : ''}`}>
                  <CardContent className="pt-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-lg">{option.emoji}</span>
                        <div>
                          <p className="font-medium text-sm">{option.label}</p>
                          <p className="text-xs text-muted-foreground">{option.description}</p>
                        </div>
                      </div>
                      <Switch
                        checked={hook.enabled}
                        onCheckedChange={v => {
                          const updated = [...hooks]
                          updated[i] = { ...updated[i], enabled: v }
                          setHooks(updated)
                        }}
                      />
                    </div>

                    {hook.enabled && (
                      <div className="space-y-1.5">
                        <Label className="text-xs">Custom Instructions (optional)</Label>
                        <Input
                          value={hook.custom_text}
                          onChange={e => {
                            const updated = [...hooks]
                            updated[i] = { ...updated[i], custom_text: e.target.value }
                            setHooks(updated)
                          }}
                          placeholder="e.g., Mention our new YOMI robotic surgery system"
                          className="h-8 text-xs"
                        />
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>

          {/* Engagement Rules */}
          <Card>
            <CardContent className="pt-5">
              <Label className="text-sm font-semibold mb-3 block">Engagement Rules</Label>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Max Attempts</Label>
                  <Input type="number" min={1} max={20} value={maxAttempts} onChange={e => setMaxAttempts(parseInt(e.target.value) || 5)} className="h-9" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Cooldown (days)</Label>
                  <Input type="number" min={1} max={30} value={cooldownDays} onChange={e => setCooldownDays(parseInt(e.target.value) || 3)} className="h-9" />
                </div>
                <div className="flex items-center gap-2 pt-5">
                  <Switch checked={stopOnReply} onCheckedChange={setStopOnReply} />
                  <Label className="text-xs">Stop on Reply</Label>
                </div>
                <div className="flex items-center gap-2 pt-5">
                  <Switch checked={transitionToLive} onCheckedChange={setTransitionToLive} />
                  <Label className="text-xs">→ Live AI on Reply</Label>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ─── Step 4: Sequence ──────────────── */}
      {currentStep === 'sequence' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">Message Sequence</h3>
              <p className="text-sm text-muted-foreground">
                Build your outreach steps. Use {"{{first_name}}, {{practice_name}}"} for personalization.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {steps.map((step, i) => (
              <Card key={i}>
                <CardContent className="py-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <GripVertical className="h-4 w-4 text-muted-foreground" />
                      <Badge variant="outline" className="text-xs">Step {step.step_number}</Badge>
                      <Input
                        value={step.name}
                        onChange={e => updateSequenceStep(i, { name: e.target.value })}
                        className="w-44 h-8 text-sm"
                        placeholder="Step name"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      {steps.length > 1 && (
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => removeSequenceStep(i)}>
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Channel</Label>
                      <Select value={step.channel} onValueChange={v => v && updateSequenceStep(i, { channel: v as 'sms' | 'email' })}>
                        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sms">
                            <span className="flex items-center gap-1.5"><MessageSquare className="h-3 w-3" /> SMS</span>
                          </SelectItem>
                          <SelectItem value="email">
                            <span className="flex items-center gap-1.5"><Mail className="h-3 w-3" /> Email</span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        <Clock className="h-3 w-3 inline mr-1" />
                        Delay
                      </Label>
                      <Select value={String(step.delay_minutes)} onValueChange={v => v && updateSequenceStep(i, { delay_minutes: parseInt(v) })}>
                        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {DELAY_PRESETS.map(d => (
                            <SelectItem key={d.value} value={String(d.value)}>{d.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="flex items-center gap-1.5">
                        <Switch
                          checked={step.ai_personalize}
                          onCheckedChange={v => updateSequenceStep(i, { ai_personalize: v })}
                        />
                        <Label className="text-xs flex items-center gap-1">
                          <Sparkles className="h-3 w-3 text-purple-500" />
                          AI Generate
                        </Label>
                      </div>
                    </div>
                  </div>

                  {step.channel === 'email' && (
                    <Input
                      value={step.subject}
                      onChange={e => updateSequenceStep(i, { subject: e.target.value })}
                      placeholder="Email subject line..."
                      className="h-8"
                    />
                  )}

                  {step.ai_personalize ? (
                    <div className="rounded-lg bg-purple-50 border border-purple-200 p-3 text-sm text-purple-700 flex items-center gap-2">
                      <Sparkles className="h-4 w-4 shrink-0" />
                      AI will generate a personalized message based on the lead&apos;s profile, your hook strategies, and active offers.
                    </div>
                  ) : (
                    <Textarea
                      value={step.body_template}
                      onChange={e => updateSequenceStep(i, { body_template: e.target.value })}
                      placeholder={step.channel === 'sms' ? 'SMS message (160 chars ideal)...' : 'Email body...'}
                      rows={step.channel === 'sms' ? 3 : 5}
                    />
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          <Button variant="outline" className="w-full gap-1.5" onClick={addSequenceStep}>
            <Plus className="h-4 w-4" /> Add Step
          </Button>
        </div>
      )}

      {/* ─── Step 5: Review ────────────────── */}
      {currentStep === 'review' && (
        <div className="space-y-4">
          <h3 className="font-semibold">Review Your Campaign</h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardContent className="pt-5 space-y-3">
                <h4 className="font-medium text-sm text-muted-foreground">Campaign Details</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Name</span>
                    <span className="font-medium">{name || '—'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Goal</span>
                    <Badge variant="secondary">{GOAL_OPTIONS.find(g => g.id === goal)?.label}</Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tone</span>
                    <Badge variant="secondary">{tone}</Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Channel</span>
                    <Badge variant="secondary">{channel}</Badge>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Steps</span>
                    <span className="font-medium">{steps.length}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5 space-y-3">
                <h4 className="font-medium text-sm text-muted-foreground">AI & Engagement</h4>
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground text-xs">Active Hooks</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {hooks.filter(h => h.enabled).map(h => {
                        const opt = HOOK_STRATEGY_OPTIONS.find(o => o.id === h.strategy)
                        return (
                          <Badge key={h.strategy} variant="outline" className="text-xs">
                            {opt?.emoji} {opt?.label}
                          </Badge>
                        )
                      })}
                    </div>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Max Attempts</span>
                    <span className="font-medium">{maxAttempts}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Cooldown</span>
                    <span className="font-medium">{cooldownDays} days</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Offers</span>
                    <span className="font-medium">{offers.filter(o => o.name).length}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {offers.length > 0 && (
            <Card>
              <CardContent className="pt-5">
                <h4 className="font-medium text-sm text-muted-foreground mb-3">Offers & Incentives</h4>
                <div className="space-y-2">
                  {offers.filter(o => o.name).map((offer, i) => (
                    <div key={i} className="flex items-center gap-3 text-sm">
                      <Gift className="h-4 w-4 text-pink-500 shrink-0" />
                      <span className="font-medium">{offer.name}</span>
                      <Badge variant="outline" className="text-xs">
                        {offer.type === 'percentage_off' ? `${offer.value}% off` :
                         offer.type === 'dollar_off' ? `$${offer.value} off` :
                         offer.type === 'free_addon' ? `Free ($${offer.value} value)` :
                         offer.type === 'financing_special' ? 'Financing Special' :
                         'Limited Time'}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="pt-5">
              <h4 className="font-medium text-sm text-muted-foreground mb-3">Sequence Preview</h4>
              <div className="space-y-2">
                {steps.map((step, i) => (
                  <div key={i} className="flex items-center gap-3 text-sm py-1.5 border-b last:border-0">
                    <Badge variant="outline" className="text-xs w-14 justify-center shrink-0">
                      {step.channel === 'sms' ? <MessageSquare className="h-3 w-3 mr-1" /> : <Mail className="h-3 w-3 mr-1" />}
                      {step.channel}
                    </Badge>
                    <span className="font-medium flex-1">{step.name}</span>
                    {step.ai_personalize && (
                      <Badge className="bg-purple-100 text-purple-700 text-xs gap-1">
                        <Sparkles className="h-3 w-3" /> AI
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {DELAY_PRESETS.find(d => d.value === step.delay_minutes)?.label || `${step.delay_minutes}min`}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ─── Navigation Footer ─────────────── */}
      <div className="flex items-center justify-between pt-4 border-t">
        <Button variant="outline" onClick={stepIndex === 0 ? onBack : prevStep} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" />
          {stepIndex === 0 ? 'Cancel' : 'Back'}
        </Button>

        {currentStep === 'review' ? (
          <Button onClick={handleSave} disabled={saving} className="gap-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
            Create Campaign
          </Button>
        ) : (
          <Button onClick={nextStep} className="gap-1.5">
            Next
            <ArrowRight className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}
