'use client'

/**
 * Workflows tab of the AI Command Center — every outreach sequence (new-lead
 * speed-to-lead + no-answer cadence, appointment confirmation/reminders,
 * custom) rendered as an editable timeline: per-step timing, channel,
 * AI vs human owner, goal (intent), and on/off.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Bot,
  UserRound,
  MessageSquare,
  Mail,
  Phone,
  PhoneCall,
  ClipboardList,
  Plus,
  Trash2,
  Zap,
  Loader2,
  AlertTriangle,
  CalendarClock,
  Sparkles,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  OutreachSequence,
  OutreachSequenceStep,
  SequenceStepChannel,
  SequenceStepCondition,
  SequenceStepOwner,
} from '@/types/database'

type SequenceWithSteps = OutreachSequence & { steps: OutreachSequenceStep[] }

type Gates = {
  followup_cron_enabled: boolean
  ai_calls_enabled: boolean
  messaging_dry_run: boolean
}

/** Editable step draft: existing rows keep their id, new rows use a temp key. */
type StepDraft = {
  id?: string
  tempKey: string
  offset_minutes: number
  channel: SequenceStepChannel
  owner: SequenceStepOwner
  condition: SequenceStepCondition
  intent: string
  enabled: boolean
  kind: 'step' | 'speed_to_lead'
}

const CHANNEL_META: Record<SequenceStepChannel, { label: string; icon: typeof MessageSquare }> = {
  sms: { label: 'Text (SMS)', icon: MessageSquare },
  email: { label: 'Email', icon: Mail },
  ai_call: { label: 'AI Call', icon: PhoneCall },
  human_call: { label: 'Staff Call', icon: Phone },
  human_task: { label: 'Staff Task', icon: ClipboardList },
}

const MIN_PER_UNIT = { minutes: 1, hours: 60, days: 1440 } as const
type Unit = keyof typeof MIN_PER_UNIT

function bestUnit(absMinutes: number): Unit {
  if (absMinutes === 0) return 'minutes'
  if (absMinutes % 1440 === 0) return 'days'
  if (absMinutes % 60 === 0) return 'hours'
  return 'minutes'
}

function describeTiming(offsetMinutes: number, anchor: OutreachSequence['anchor']): string {
  const abs = Math.abs(offsetMinutes)
  const unit = bestUnit(abs)
  const value = Math.round(abs / MIN_PER_UNIT[unit])
  const span = `${value} ${value === 1 ? unit.slice(0, -1) : unit}`
  if (anchor === 'appointment_time') {
    return offsetMinutes < 0 ? `${span} before appt` : offsetMinutes === 0 ? 'At appt time' : `${span} after appt`
  }
  return offsetMinutes === 0 ? 'Instantly' : `${span} after lead`
}

function toDraft(step: OutreachSequenceStep): StepDraft {
  return {
    id: step.id,
    tempKey: step.id,
    offset_minutes: step.offset_minutes,
    channel: step.channel,
    owner: step.owner,
    condition: step.condition,
    intent: step.intent ?? '',
    enabled: step.enabled,
    kind: step.kind,
  }
}

export function WorkflowSequences({ isAdmin }: { isAdmin: boolean }) {
  const [loading, setLoading] = useState(true)
  const [sequences, setSequences] = useState<SequenceWithSteps[]>([])
  const [gates, setGates] = useState<Gates | null>(null)
  const [drafts, setDrafts] = useState<Record<string, StepDraft[]>>({})
  const [dirty, setDirty] = useState<Record<string, boolean>>({})
  const [savingSeq, setSavingSeq] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/automation/sequences')
      if (!res.ok) throw new Error('Failed to load workflows')
      const data = await res.json()
      const seqs: SequenceWithSteps[] = data.sequences ?? []
      setSequences(seqs)
      setGates(data.gates ?? null)
      setDrafts(Object.fromEntries(seqs.map((s) => [s.id, s.steps.map(toDraft)])))
      setDirty({})
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load workflows')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function updateStep(seqId: string, tempKey: string, patch: Partial<StepDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [seqId]: (prev[seqId] ?? []).map((s) => (s.tempKey === tempKey ? { ...s, ...patch } : s)),
    }))
    setDirty((prev) => ({ ...prev, [seqId]: true }))
  }

  function removeStep(seqId: string, tempKey: string) {
    setDrafts((prev) => ({
      ...prev,
      [seqId]: (prev[seqId] ?? []).filter((s) => s.tempKey !== tempKey),
    }))
    setDirty((prev) => ({ ...prev, [seqId]: true }))
  }

  function addStep(seq: SequenceWithSteps) {
    const list = drafts[seq.id] ?? []
    const last = list[list.length - 1]
    const isAppt = seq.anchor === 'appointment_time'
    setDrafts((prev) => ({
      ...prev,
      [seq.id]: [
        ...list,
        {
          tempKey: `new-${Date.now()}-${list.length}`,
          offset_minutes: isAppt ? -60 : (last?.offset_minutes ?? 0) + 1440,
          channel: 'sms',
          owner: 'ai',
          condition: 'always',
          intent: '',
          enabled: true,
          kind: 'step',
        },
      ],
    }))
    setDirty((prev) => ({ ...prev, [seq.id]: true }))
  }

  async function patchSequence(seqId: string, updates: Partial<OutreachSequence>) {
    const res = await fetch(`/api/automation/sequences/${seqId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Failed to update workflow')
    }
    const { sequence } = await res.json()
    setSequences((prev) => prev.map((s) => (s.id === seqId ? { ...s, ...sequence } : s)))
  }

  async function toggleSequence(seq: SequenceWithSteps, field: 'enabled' | 'stop_on_reply' | 'stop_on_booking', value: boolean) {
    try {
      await patchSequence(seq.id, { [field]: value })
      toast.success(field === 'enabled' ? (value ? `${seq.name} enabled` : `${seq.name} paused`) : 'Saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save')
    }
  }

  async function saveSteps(seq: SequenceWithSteps) {
    setSavingSeq(seq.id)
    try {
      // Positions follow the timeline order (speed-to-lead proxy stays first).
      const ordered = [...(drafts[seq.id] ?? [])].sort((a, b) => {
        if (a.kind === 'speed_to_lead') return -1
        if (b.kind === 'speed_to_lead') return 1
        return a.offset_minutes - b.offset_minutes
      })
      const payload = ordered.map((s, i) => ({
        ...(s.id ? { id: s.id } : {}),
        position: i,
        offset_minutes: s.offset_minutes,
        channel: s.channel,
        owner: s.owner,
        condition: s.condition,
        intent: s.intent.trim() ? s.intent.trim() : null,
        enabled: s.enabled,
      }))
      const res = await fetch(`/api/automation/sequences/${seq.id}/steps`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps: payload }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to save steps')
      const steps: OutreachSequenceStep[] = data.steps ?? []
      setSequences((prev) => prev.map((s) => (s.id === seq.id ? { ...s, steps } : s)))
      setDrafts((prev) => ({ ...prev, [seq.id]: steps.map(toDraft) }))
      setDirty((prev) => ({ ...prev, [seq.id]: false }))
      for (const w of data.warnings ?? []) toast.warning(w)
      toast.success('Workflow saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save steps')
    } finally {
      setSavingSeq(null)
    }
  }

  const gateNotes = useMemo(() => {
    if (!gates) return []
    const notes: string[] = []
    if (gates.messaging_dry_run) notes.push('Messaging dry-run is ACTIVE — no texts or emails actually send.')
    if (!gates.followup_cron_enabled) notes.push('Follow-up cron is off (FOLLOWUP_SEQUENCES_ENABLED) — the new-lead cadence is not firing yet.')
    if (!gates.ai_calls_enabled) notes.push('AI voice is off — AI Call steps create staff call tasks instead.')
    return notes
  }, [gates])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-aurea-ink-3">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {gateNotes.length > 0 && (
        <div className="rounded-lg border border-aurea-amber/30 bg-aurea-amber/[0.05] p-4 space-y-1.5">
          {gateNotes.map((n) => (
            <div key={n} className="flex items-center gap-2 text-[12.5px] text-aurea-ink-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-aurea-amber" strokeWidth={1.75} />
              {n}
            </div>
          ))}
        </div>
      )}

      {sequences.map((seq) => {
        const steps = drafts[seq.id] ?? []
        const isAppt = seq.anchor === 'appointment_time'
        return (
          <div key={seq.id} className="aurea-card overflow-hidden">
            {/* ── Sequence header ── */}
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-aurea-border px-5 py-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-aurea-primary/10 ring-1 ring-aurea-primary/20">
                  {isAppt ? (
                    <CalendarClock className="h-[18px] w-[18px] text-aurea-primary" strokeWidth={1.75} />
                  ) : (
                    <Zap className="h-[18px] w-[18px] text-aurea-primary" strokeWidth={1.75} />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="aurea-display text-[18px] text-aurea-ink">{seq.name}</h2>
                    <span className="rounded-full border border-aurea-border px-2 py-0.5 text-[10.5px] uppercase tracking-wide text-aurea-ink-3">
                      {seq.trigger === 'appointment' ? 'On appointment booked' : 'On new lead'}
                    </span>
                  </div>
                  {seq.description && (
                    <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-aurea-ink-3">{seq.description}</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-4">
                    {!isAppt && (
                      <>
                        <label className="flex items-center gap-1.5 text-[12px] text-aurea-ink-2">
                          <Switch
                            checked={seq.stop_on_reply}
                            onCheckedChange={(v) => toggleSequence(seq, 'stop_on_reply', v)}
                            disabled={!isAdmin}
                          />
                          Stop when they reply
                        </label>
                        <label className="flex items-center gap-1.5 text-[12px] text-aurea-ink-2">
                          <Switch
                            checked={seq.stop_on_booking}
                            onCheckedChange={(v) => toggleSequence(seq, 'stop_on_booking', v)}
                            disabled={!isAdmin}
                          />
                          Stop when they book
                        </label>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-[12px] font-medium ${seq.enabled ? 'text-aurea-primary' : 'text-aurea-ink-3'}`}>
                  {seq.enabled ? 'Active' : 'Paused'}
                </span>
                <Switch
                  checked={seq.enabled}
                  onCheckedChange={(v) => toggleSequence(seq, 'enabled', v)}
                  disabled={!isAdmin}
                />
              </div>
            </div>

            {/* ── Timeline ── */}
            <div className="p-5 space-y-3">
              {steps.map((step) => {
                const meta = CHANNEL_META[step.channel]
                const Icon = step.kind === 'speed_to_lead' ? Sparkles : meta.icon
                const abs = Math.abs(step.offset_minutes)
                const unit = bestUnit(abs)
                const value = Math.round(abs / MIN_PER_UNIT[unit])
                const isProxy = step.kind === 'speed_to_lead'
                return (
                  <div
                    key={step.tempKey}
                    className={`flex flex-wrap items-start gap-3 rounded-lg border p-3 ${
                      step.enabled ? 'border-aurea-border' : 'border-aurea-border/60 opacity-55'
                    }`}
                  >
                    <div className={`mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                      step.owner === 'ai' ? 'bg-aurea-primary/10 text-aurea-primary' : 'bg-aurea-amber/10 text-aurea-amber'
                    }`}>
                      <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </div>

                    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                      {/* Row 1: timing + channel + owner */}
                      <div className="flex flex-wrap items-center gap-2.5">
                        {isProxy ? (
                          <span className="rounded-md bg-aurea-primary/10 px-2 py-1 text-[11.5px] font-medium text-aurea-primary">
                            Instant · Speed-to-lead
                          </span>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <Input
                              type="number"
                              min={0}
                              value={value}
                              disabled={!isAdmin}
                              className="h-8 w-[70px] text-[13px]"
                              onChange={(e) => {
                                const v = Math.max(0, Number(e.target.value) || 0)
                                const minutes = v * MIN_PER_UNIT[unit]
                                updateStep(seq.id, step.tempKey, {
                                  offset_minutes: isAppt && step.offset_minutes <= 0 ? -minutes : minutes,
                                })
                              }}
                            />
                            <Select
                              value={unit}
                              disabled={!isAdmin}
                              onValueChange={(u) => {
                                const minutes = value * MIN_PER_UNIT[u as Unit]
                                updateStep(seq.id, step.tempKey, {
                                  offset_minutes: isAppt && step.offset_minutes <= 0 ? -minutes : minutes,
                                })
                              }}
                            >
                              <SelectTrigger className="h-8 w-[92px] text-[13px]"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="minutes">minutes</SelectItem>
                                <SelectItem value="hours">hours</SelectItem>
                                <SelectItem value="days">days</SelectItem>
                              </SelectContent>
                            </Select>
                            <span className="text-[12px] text-aurea-ink-3">
                              {isAppt ? (step.offset_minutes <= 0 ? 'before appt' : 'after appt') : 'after lead created'}
                            </span>
                          </div>
                        )}

                        {!isProxy && (
                          <Select
                            value={step.channel}
                            disabled={!isAdmin}
                            onValueChange={(c) => updateStep(seq.id, step.tempKey, { channel: c as SequenceStepChannel })}
                          >
                            <SelectTrigger className="h-8 w-[130px] text-[13px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {Object.entries(CHANNEL_META).map(([val, m]) => (
                                <SelectItem key={val} value={val}>{m.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}

                        {/* AI / Human owner segmented toggle */}
                        <div className="flex overflow-hidden rounded-md border border-aurea-border">
                          {(['ai', 'human'] as const).map((o) => (
                            <button
                              key={o}
                              type="button"
                              disabled={!isAdmin}
                              onClick={() => updateStep(seq.id, step.tempKey, { owner: o })}
                              className={`flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                                step.owner === o
                                  ? o === 'ai'
                                    ? 'bg-aurea-primary/10 text-aurea-primary'
                                    : 'bg-aurea-amber/10 text-aurea-amber'
                                  : 'text-aurea-ink-3 hover:bg-aurea-surface-2'
                              }`}
                            >
                              {o === 'ai' ? <Bot className="h-3.5 w-3.5" strokeWidth={1.75} /> : <UserRound className="h-3.5 w-3.5" strokeWidth={1.75} />}
                              {o === 'ai' ? 'AI' : 'Human'}
                            </button>
                          ))}
                        </div>

                        {isAppt && !isProxy && (
                          <Select
                            value={step.condition}
                            disabled={!isAdmin}
                            onValueChange={(c) => updateStep(seq.id, step.tempKey, { condition: c as SequenceStepCondition })}
                          >
                            <SelectTrigger className="h-8 w-[150px] text-[13px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="always">Always</SelectItem>
                              <SelectItem value="unconfirmed">If unconfirmed</SelectItem>
                              <SelectItem value="confirmed">If confirmed</SelectItem>
                            </SelectContent>
                          </Select>
                        )}

                        <span className="ml-auto text-[11.5px] font-medium text-aurea-ink-3">
                          {describeTiming(step.offset_minutes, seq.anchor)}
                        </span>
                      </div>

                      {/* Row 2: intent */}
                      <Textarea
                        value={step.intent}
                        disabled={!isAdmin}
                        rows={1}
                        placeholder={
                          step.owner === 'ai'
                            ? 'Goal for the AI (e.g. "Day-2 nudge: ask if they still want to explore, mention financing")'
                            : 'Instructions for staff (shows on the task)'
                        }
                        className="min-h-[34px] resize-y text-[12.5px]"
                        onChange={(e) => updateStep(seq.id, step.tempKey, { intent: e.target.value })}
                      />
                    </div>

                    <div className="flex shrink-0 items-center gap-2 pt-1">
                      <Switch
                        checked={step.enabled}
                        disabled={!isAdmin}
                        onCheckedChange={(v) => updateStep(seq.id, step.tempKey, { enabled: v })}
                      />
                      {!isProxy && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-aurea-ink-3 hover:text-aurea-rose"
                          disabled={!isAdmin}
                          onClick={() => removeStep(seq.id, step.tempKey)}
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}

              <div className="flex items-center justify-between pt-1">
                <Button variant="outline" size="sm" className="gap-1.5 text-[12.5px]" disabled={!isAdmin} onClick={() => addStep(seq)}>
                  <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                  Add step
                </Button>
                {dirty[seq.id] && (
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" className="text-[12.5px]" disabled={savingSeq === seq.id} onClick={() => void load()}>
                      Discard
                    </Button>
                    <Button size="sm" className="gap-1.5 text-[12.5px]" disabled={!isAdmin || savingSeq === seq.id} onClick={() => saveSteps(seq)}>
                      {savingSeq === seq.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      Save workflow
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}

      {sequences.length === 0 && (
        <div className="aurea-card p-10 text-center text-[13px] text-aurea-ink-3">
          No workflows defined yet — run the outreach sequences migration to seed the defaults.
        </div>
      )}
    </div>
  )
}
