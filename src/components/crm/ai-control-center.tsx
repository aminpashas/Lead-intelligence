'use client'

import { useState, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Power,
  Pause,
  Play,
  Shield,
  Clock,
  Zap,
  MessageSquare,
  Bot,
  UserRound,
  BrainCircuit,
  AlertTriangle,
  Activity,
  Calendar,
  X,
  Plus,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { formatDistanceToNow } from 'date-fns'
import { AIModeToggle } from './ai-mode-toggle'
import type { AIMode } from '@/types/database'
import { DEFAULT_SCHEDULE, type WeekSchedule } from '@/lib/autopilot/config'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SettingsData = Record<string, any>

type AIControlCenterProps = {
  settings: SettingsData
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conversations: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recentActivities: any[]
  pendingEscalations: number
  isAdmin: boolean
}

export function AIControlCenter({
  settings: initialSettings,
  conversations,
  recentActivities,
  pendingEscalations,
  isAdmin,
}: AIControlCenterProps) {
  const [settings, setSettings] = useState<SettingsData>(initialSettings)
  const [saving, setSaving] = useState(false)
  const [killSwitching, setKillSwitching] = useState(false)
  const [newStopWord, setNewStopWord] = useState('')
  const [scheduleEnabled, setScheduleEnabled] = useState(!!settings.autopilot_schedule)
  const [schedule, setSchedule] = useState<WeekSchedule>(
    (settings.autopilot_schedule as WeekSchedule) || DEFAULT_SCHEDULE
  )

  const isEnabled = settings.autopilot_enabled ?? false
  const isPaused = settings.autopilot_paused ?? false
  const mode = settings.autopilot_mode ?? 'full'

  // ── Save helper ──────────────────────────────────────────
  const saveSettings = useCallback(async (updates: Record<string, unknown>) => {
    setSaving(true)
    try {
      const res = await fetch('/api/autopilot/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to save')
      }
      setSettings(prev => ({ ...prev, ...updates }))
      toast.success('Settings saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }, [])

  // ── Kill Switch ──────────────────────────────────────────
  async function handleKillSwitch() {
    setKillSwitching(true)
    try {
      const res = await fetch('/api/autopilot/kill-switch', { method: 'POST' })
      if (!res.ok) throw new Error('Kill switch failed')
      setSettings(prev => ({ ...prev, autopilot_paused: true }))
      toast.success('⚠️ AI PAUSED — No messages will be sent', { duration: 5000 })
    } catch {
      toast.error('Failed to activate kill switch')
    } finally {
      setKillSwitching(false)
    }
  }

  async function handleResume() {
    await saveSettings({ autopilot_paused: false })
    toast.success('✅ AI Resumed — Autonomous mode active')
  }

  async function handleToggleEnabled() {
    await saveSettings({ autopilot_enabled: !isEnabled })
  }

  // ── Schedule helpers ─────────────────────────────────────
  function updateDaySchedule(day: keyof WeekSchedule, field: string, value: unknown) {
    setSchedule(prev => ({
      ...prev,
      [day]: { ...prev[day], [field]: value },
    }))
  }

  async function saveSchedule() {
    if (scheduleEnabled) {
      await saveSettings({ autopilot_schedule: schedule })
    } else {
      await saveSettings({ autopilot_schedule: null })
    }
  }

  // ── Stop words ───────────────────────────────────────────
  const stopWords: string[] = settings.autopilot_stop_words || []

  async function addStopWord() {
    if (!newStopWord.trim()) return
    const updated = [...stopWords, newStopWord.trim().toLowerCase()]
    await saveSettings({ autopilot_stop_words: updated })
    setNewStopWord('')
  }

  async function removeStopWord(word: string) {
    const updated = stopWords.filter((w: string) => w !== word)
    await saveSettings({ autopilot_stop_words: updated })
  }

  // ── Counts ───────────────────────────────────────────────
  const aiAutoCount = conversations.filter((c: { ai_mode: string }) => c.ai_mode === 'auto').length
  const aiAssistCount = conversations.filter((c: { ai_mode: string }) => c.ai_mode === 'assist').length
  const aiOffCount = conversations.filter((c: { ai_mode: string; ai_enabled?: boolean }) => c.ai_mode === 'off' || !c.ai_enabled).length

  const DAY_LABELS: Array<{ key: keyof WeekSchedule; label: string; short: string }> = [
    { key: 'monday', label: 'Monday', short: 'Mon' },
    { key: 'tuesday', label: 'Tuesday', short: 'Tue' },
    { key: 'wednesday', label: 'Wednesday', short: 'Wed' },
    { key: 'thursday', label: 'Thursday', short: 'Thu' },
    { key: 'friday', label: 'Friday', short: 'Fri' },
    { key: 'saturday', label: 'Saturday', short: 'Sat' },
    { key: 'sunday', label: 'Sunday', short: 'Sun' },
  ]

  return (
    <div className="animate-in fade-in-0 duration-500 space-y-6">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="flex items-start justify-between gap-4 border-b border-aurea-border pb-8">
        <div>
          <p className="aurea-eyebrow mb-3">AI Autopilot</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink sm:text-[52px]">Control Center</h1>
          <p className="mt-4 max-w-2xl text-[16px] leading-relaxed text-aurea-ink-2">
            Control when and how your AI agents operate — per conversation, per lead, or globally.
          </p>
        </div>
        {pendingEscalations > 0 && (
          <div className="shrink-0 flex items-center gap-1.5 rounded-md border border-aurea-rose/30 bg-aurea-rose/5 px-3 py-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-aurea-rose" strokeWidth={1.75} />
            <span className="text-[12px] font-medium text-aurea-rose">
              {pendingEscalations} pending escalation{pendingEscalations > 1 ? 's' : ''}
            </span>
          </div>
        )}
      </header>

      {/* ══════════════════════════════════════════════════════
          A. MASTER CONTROLS
          ══════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Kill Switch */}
        <div className={`aurea-card p-6 text-center space-y-5 ${
          isPaused
            ? 'ring-1 ring-aurea-rose/30 bg-aurea-rose/[0.03]'
            : isEnabled
            ? 'ring-1 ring-aurea-primary/20 bg-aurea-primary/[0.02]'
            : ''
        }`}>
          <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${
            isPaused ? 'bg-aurea-rose/10 ring-1 ring-aurea-rose/20' :
            isEnabled ? 'bg-aurea-primary/10 ring-1 ring-aurea-primary/20' :
            'bg-aurea-surface-2 ring-1 ring-aurea-border'
          }`}>
            {isPaused ? (
              <Pause className="h-8 w-8 text-aurea-rose" strokeWidth={1.75} />
            ) : isEnabled ? (
              <Play className="h-8 w-8 text-aurea-primary" strokeWidth={1.75} />
            ) : (
              <Power className="h-8 w-8 text-aurea-ink-3" strokeWidth={1.75} />
            )}
          </div>
          <div>
            <h3 className="aurea-display text-[20px] text-aurea-ink">
              {isPaused ? 'AI Paused' : isEnabled ? 'AI Active' : 'AI Disabled'}
            </h3>
            <p className="mt-1 text-[12px] text-aurea-ink-3">
              {isPaused ? 'All AI auto-sends are halted' : isEnabled ? 'AI is responding autonomously' : 'AI is completely off'}
            </p>
          </div>
          <div className="flex flex-col gap-2">
            {isEnabled && !isPaused ? (
              <Button
                variant="destructive"
                className="w-full gap-2"
                onClick={handleKillSwitch}
                disabled={killSwitching || !isAdmin}
              >
                {killSwitching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" strokeWidth={1.75} />}
                KILL SWITCH — Pause All AI
              </Button>
            ) : isPaused ? (
              <Button
                className="w-full gap-2 bg-aurea-primary hover:bg-aurea-primary/90 text-white"
                onClick={handleResume}
                disabled={saving || !isAdmin}
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" strokeWidth={1.75} />}
                Resume AI
              </Button>
            ) : null}
            <div className="flex items-center justify-center gap-3">
              <span className="text-[13px] text-aurea-ink-2">AI Enabled</span>
              <Switch
                checked={isEnabled}
                onCheckedChange={() => handleToggleEnabled()}
                disabled={saving || !isAdmin}
              />
            </div>
          </div>
        </div>

        {/* Mode */}
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
            <BrainCircuit className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
            <div>
              <h2 className="aurea-display text-[18px] text-aurea-ink">Operating Mode</h2>
              <p className="text-[12px] text-aurea-ink-3">How should the AI handle responses?</p>
            </div>
          </div>
          <div className="space-y-2 p-4">
            {[
              { value: 'full', label: 'Full Auto', desc: 'AI sends responses autonomously', icon: Bot },
              { value: 'review_first', label: 'Review First Messages', desc: 'Human reviews first response only', icon: UserRound },
              { value: 'review_closers', label: 'Review Closers', desc: 'Human reviews all closer agent responses', icon: Shield },
            ].map((m) => (
              <button
                key={m.value}
                onClick={() => saveSettings({ autopilot_mode: m.value })}
                disabled={saving || !isAdmin}
                className={`w-full flex items-center gap-3 p-3 rounded-lg border text-left transition-all ${
                  mode === m.value
                    ? 'border-aurea-primary/30 bg-aurea-primary/5 ring-1 ring-aurea-primary/10'
                    : 'border-aurea-border hover:bg-aurea-surface-2'
                }`}
              >
                <m.icon className={`h-[17px] w-[17px] shrink-0 ${mode === m.value ? 'text-aurea-primary' : 'text-aurea-ink-3'}`} strokeWidth={1.75} />
                <div>
                  <span className={`text-[13px] font-medium ${mode === m.value ? 'text-aurea-primary' : 'text-aurea-ink'}`}>{m.label}</span>
                  <p className="text-[11px] text-aurea-ink-3">{m.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Quick Stats */}
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
            <Activity className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
            <h2 className="aurea-display text-[18px] text-aurea-ink">Live Overview</h2>
          </div>
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-aurea-border bg-aurea-surface-2 p-3">
                <p className="aurea-display text-[22px] tabular-nums text-aurea-primary">{aiAutoCount}</p>
                <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-aurea-ink-3">AI Auto</p>
              </div>
              <div className="rounded-lg border border-aurea-border bg-aurea-surface-2 p-3">
                <p className="aurea-display text-[22px] tabular-nums text-aurea-amber">{aiAssistCount}</p>
                <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-aurea-ink-3">AI Assist</p>
              </div>
              <div className="rounded-lg border border-aurea-border bg-aurea-surface-2 p-3">
                <p className="aurea-display text-[22px] tabular-nums text-aurea-ink">{aiOffCount}</p>
                <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-aurea-ink-3">Human</p>
              </div>
            </div>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-aurea-ink-2">Total Conversations</span>
                <span className="font-mono tabular-nums text-aurea-ink">{conversations.length}</span>
              </div>
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-aurea-ink-2">Pending Escalations</span>
                <span className={`font-mono tabular-nums ${pendingEscalations > 0 ? 'text-aurea-rose' : 'text-aurea-ink'}`}>
                  {pendingEscalations}
                </span>
              </div>
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-aurea-ink-2">Speed-to-Lead</span>
                <Switch
                  checked={settings.autopilot_speed_to_lead ?? true}
                  onCheckedChange={(v) => saveSettings({ autopilot_speed_to_lead: v })}
                  disabled={!isAdmin}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          B. SCHEDULE & HYBRID MODE
          ══════════════════════════════════════════════════════ */}
      <div className="aurea-card overflow-hidden">
        <div className="flex items-start justify-between gap-4 border-b border-aurea-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Calendar className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
            <div>
              <h2 className="aurea-display text-[18px] text-aurea-ink">Weekly Schedule — Hybrid Mode</h2>
              <p className="text-[12px] text-aurea-ink-3">
                Set which days and hours the AI should operate. Outside these hours, a human handles conversations.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="text-[13px] text-aurea-ink-2">Custom Schedule</span>
            <Switch
              checked={scheduleEnabled}
              onCheckedChange={(v) => {
                setScheduleEnabled(v)
                if (!v) saveSettings({ autopilot_schedule: null })
              }}
              disabled={!isAdmin}
            />
          </div>
        </div>

        {scheduleEnabled && (
          <>
            {/* Quick presets */}
            <div className="flex gap-2 border-b border-aurea-border px-5 py-3">
              {[
                { label: '24/7', fn: () => setSchedule(Object.fromEntries(DAY_LABELS.map(d => [d.key, { enabled: true, start: 0, end: 24 }])) as WeekSchedule) },
                { label: 'Business Hours', fn: () => setSchedule(DEFAULT_SCHEDULE) },
                { label: 'Weekdays Only', fn: () => setSchedule(Object.fromEntries(DAY_LABELS.map(d => [d.key, { enabled: !['saturday', 'sunday'].includes(d.key), start: 8, end: 21 }])) as WeekSchedule) },
              ].map((preset) => (
                <Button key={preset.label} variant="outline" size="sm" className="text-xs" onClick={preset.fn}>
                  {preset.label}
                </Button>
              ))}
              <Button variant="default" size="sm" className="text-xs ml-auto gap-1 bg-aurea-primary hover:bg-aurea-primary/90 text-white" onClick={saveSchedule} disabled={saving}>
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Save Schedule
              </Button>
            </div>

            <div className="p-4 space-y-2">
              {DAY_LABELS.map((day) => {
                const d = schedule[day.key]
                return (
                  <div
                    key={day.key}
                    className={`flex items-center gap-4 rounded-lg border p-3 transition-all ${
                      d.enabled ? 'border-aurea-border bg-aurea-canvas' : 'border-aurea-border bg-aurea-surface-2 opacity-60'
                    }`}
                  >
                    <div className="w-20">
                      <span className="text-[13px] font-medium text-aurea-ink">{day.short}</span>
                    </div>
                    <Switch
                      checked={d.enabled}
                      onCheckedChange={(v) => updateDaySchedule(day.key, 'enabled', v)}
                      disabled={!isAdmin}
                    />
                    {d.enabled ? (
                      <>
                        <div className="flex items-center gap-2 text-[13px]">
                          <Select items={Object.fromEntries(Array.from({ length: 24 }, (_, i) => [String(i), `${i}:00`]))} value={String(d.start)} onValueChange={(v) => v && updateDaySchedule(day.key, 'start', parseInt(v))}>
                            <SelectTrigger className="w-20 h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from({ length: 24 }, (_, i) => (
                                <SelectItem key={i} value={String(i)}>{`${i}:00`}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span className="text-aurea-ink-3">to</span>
                          <Select items={Object.fromEntries(Array.from({ length: 24 }, (_, i) => i + 1).map((i) => [String(i), `${i}:00`]))} value={String(d.end)} onValueChange={(v) => v && updateDaySchedule(day.key, 'end', parseInt(v))}>
                            <SelectTrigger className="w-20 h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from({ length: 24 }, (_, i) => i + 1).map((i) => (
                                <SelectItem key={i} value={String(i)}>{`${i}:00`}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Select items={{ full: 'Full Auto', review_first: 'Review First', review_closers: 'Review Closers' }} value={d.mode || 'full'} onValueChange={(v) => v && updateDaySchedule(day.key, 'mode', v)}>
                          <SelectTrigger className="w-36 h-8 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="full">Full Auto</SelectItem>
                            <SelectItem value="review_first">Review First</SelectItem>
                            <SelectItem value="review_closers">Review Closers</SelectItem>
                          </SelectContent>
                        </Select>
                        {/* Visual bar */}
                        <div className="flex-1 h-5 bg-aurea-surface-2 rounded-full overflow-hidden relative border border-aurea-border">
                          <div
                            className="h-full bg-aurea-primary/25 absolute"
                            style={{
                              left: `${(d.start / 24) * 100}%`,
                              width: `${((d.end - d.start) / 24) * 100}%`,
                            }}
                          />
                          <div className="absolute inset-0 flex items-center justify-center text-[9px] font-mono text-aurea-ink-3">
                            {d.end - d.start}h active
                          </div>
                        </div>
                      </>
                    ) : (
                      <span className="text-[12px] text-aurea-ink-3">AI off — human only</span>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════
          C. CONFIDENCE & SAFETY
          ══════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Confidence & Safety */}
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
            <Shield className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
            <div>
              <h2 className="aurea-display text-[18px] text-aurea-ink">Confidence & Safety</h2>
              <p className="text-[12px] text-aurea-ink-3">Fine-tune when AI sends automatically vs escalates</p>
            </div>
          </div>
          <div className="p-5 space-y-6">
            {/* Confidence threshold */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-[13px] font-medium text-aurea-ink">Confidence Threshold</label>
                <span className="font-mono text-[13px] tabular-nums text-aurea-primary">
                  {Math.round((settings.autopilot_confidence_threshold ?? 0.75) * 100)}%
                </span>
              </div>
              <Slider
                value={[Math.round((settings.autopilot_confidence_threshold ?? 0.75) * 100)]}
                min={30}
                max={100}
                step={5}
                onValueCommit={(v) => saveSettings({ autopilot_confidence_threshold: v[0] / 100 })}
                disabled={!isAdmin}
              />
              <p className="text-[11.5px] text-aurea-ink-3">
                Below this confidence, AI drafts are sent for human review instead of auto-sending
              </p>
            </div>

            {/* Max messages per hour */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[13px] font-medium text-aurea-ink">Max Messages / Hour</label>
                <span className="font-mono text-[13px] tabular-nums text-aurea-ink">{settings.autopilot_max_messages_per_hour ?? 10}</span>
              </div>
              <Slider
                value={[settings.autopilot_max_messages_per_hour ?? 10]}
                min={1}
                max={30}
                step={1}
                onValueCommit={(v) => saveSettings({ autopilot_max_messages_per_hour: v[0] })}
                disabled={!isAdmin}
              />
              <p className="text-[11.5px] text-aurea-ink-3">Per conversation rate limit to prevent spam</p>
            </div>

            {/* Response delay */}
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-aurea-ink">Response Delay Range</label>
              <div className="flex items-center gap-3">
                <div className="space-y-1">
                  <span className="text-[11px] text-aurea-ink-3">Min (seconds)</span>
                  <Input
                    type="number"
                    min={5}
                    max={600}
                    value={settings.autopilot_response_delay_min ?? 30}
                    onChange={(e) => setSettings(prev => ({ ...prev, autopilot_response_delay_min: parseInt(e.target.value) || 30 }))}
                    onBlur={() => saveSettings({ autopilot_response_delay_min: settings.autopilot_response_delay_min })}
                    className="w-24 h-8 text-sm"
                    disabled={!isAdmin}
                  />
                </div>
                <span className="text-aurea-ink-3 pt-5">—</span>
                <div className="space-y-1">
                  <span className="text-[11px] text-aurea-ink-3">Max (seconds)</span>
                  <Input
                    type="number"
                    min={10}
                    max={1800}
                    value={settings.autopilot_response_delay_max ?? 180}
                    onChange={(e) => setSettings(prev => ({ ...prev, autopilot_response_delay_max: parseInt(e.target.value) || 180 }))}
                    onBlur={() => saveSettings({ autopilot_response_delay_max: settings.autopilot_response_delay_max })}
                    className="w-24 h-8 text-sm"
                    disabled={!isAdmin}
                  />
                </div>
              </div>
              <p className="text-[11.5px] text-aurea-ink-3">
                AI waits a random delay in this range before responding (feels more human)
              </p>
            </div>
          </div>
        </div>

        {/* Stop Words */}
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
            <MessageSquare className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
            <div>
              <h2 className="aurea-display text-[18px] text-aurea-ink">Stop Words</h2>
              <p className="text-[12px] text-aurea-ink-3">Opt-Out Detection — AI stops when these words appear</p>
            </div>
          </div>
          <div className="p-5 space-y-3">
            <div className="flex gap-2">
              <Input
                value={newStopWord}
                onChange={(e) => setNewStopWord(e.target.value)}
                placeholder="Add stop word..."
                className="h-8 text-sm"
                onKeyDown={(e) => e.key === 'Enter' && addStopWord()}
                disabled={!isAdmin}
              />
              <Button size="sm" variant="outline" onClick={addStopWord} disabled={!newStopWord.trim() || !isAdmin}>
                <Plus className="h-3 w-3" />
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {stopWords.map((word: string) => (
                <span
                  key={word}
                  className="inline-flex items-center gap-1 rounded-md border border-aurea-border bg-aurea-surface-2 px-2 py-0.5 text-[12px] text-aurea-ink-2"
                >
                  {word}
                  <button
                    onClick={() => removeStopWord(word)}
                    className="ml-0.5 rounded-full hover:bg-aurea-rose/10 p-0.5 transition-colors"
                    disabled={!isAdmin}
                  >
                    <X className="h-2.5 w-2.5 text-aurea-ink-3 hover:text-aurea-rose" />
                  </button>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          D. ACTIVE CONVERSATIONS MONITOR
          ══════════════════════════════════════════════════════ */}
      <div className="aurea-card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
          <Zap className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
          <div>
            <h2 className="aurea-display text-[18px] text-aurea-ink">Active Conversations — AI Status</h2>
            <p className="text-[12px] text-aurea-ink-3">Monitor and control AI mode for every active conversation</p>
          </div>
        </div>
        <div className="p-5">
          {conversations.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-aurea-ink-3">No active conversations</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-aurea-border">
                    <th className="pb-2.5 text-left aurea-eyebrow font-normal">Lead</th>
                    <th className="pb-2.5 text-left aurea-eyebrow font-normal">Channel</th>
                    <th className="pb-2.5 text-left aurea-eyebrow font-normal">Agent</th>
                    <th className="pb-2.5 text-left aurea-eyebrow font-normal">AI Mode</th>
                    <th className="pb-2.5 text-left aurea-eyebrow font-normal">Last Message</th>
                    <th className="pb-2.5 text-left aurea-eyebrow font-normal">Lead Override</th>
                  </tr>
                </thead>
                <tbody>
                  {conversations.slice(0, 25).map((convo: {
                    id: string
                    channel: string
                    ai_mode: AIMode
                    active_agent: string
                    last_message_at: string
                    last_message_preview: string
                    message_count: number
                    lead: { id: string; first_name: string; last_name: string; ai_qualification: string; status: string; ai_autopilot_override: string } | null
                  }) => (
                    <tr key={convo.id} className="border-b border-aurea-border last:border-0 hover:bg-aurea-surface-2 transition-colors">
                      <td className="py-3">
                        <p className="font-medium text-aurea-ink">
                          {convo.lead?.first_name} {convo.lead?.last_name}
                        </p>
                        <p className="text-[11px] text-aurea-ink-3">{convo.lead?.status}</p>
                      </td>
                      <td className="py-3">
                        <Badge variant="outline" className="text-xs">{convo.channel}</Badge>
                      </td>
                      <td className="py-3">
                        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                          convo.active_agent === 'setter'
                            ? 'border-aurea-primary/30 bg-aurea-primary/5 text-aurea-primary'
                            : convo.active_agent === 'closer'
                            ? 'border-aurea-amber/30 bg-aurea-amber/5 text-aurea-amber'
                            : 'border-aurea-border bg-aurea-surface-2 text-aurea-ink-3'
                        }`}>
                          {convo.active_agent || 'none'}
                        </span>
                      </td>
                      <td className="py-3">
                        <AIModeToggle
                          conversationId={convo.id}
                          currentMode={convo.ai_mode || 'off'}
                          size="sm"
                          showLabel={false}
                        />
                      </td>
                      <td className="py-3">
                        <span className="font-mono text-[11px] text-aurea-ink-3">
                          {convo.last_message_at
                            ? formatDistanceToNow(new Date(convo.last_message_at), { addSuffix: true })
                            : '—'}
                        </span>
                      </td>
                      <td className="py-3">
                        <span className="inline-flex items-center rounded-md border border-aurea-border bg-aurea-surface-2 px-2 py-0.5 text-[10px] text-aurea-ink-3">
                          {convo.lead?.ai_autopilot_override || 'default'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {conversations.length > 25 && (
                <p className="mt-3 text-center text-[11.5px] text-aurea-ink-3">
                  Showing 25 of {conversations.length} conversations
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════
          E. RECENT AI ACTIVITY FEED
          ══════════════════════════════════════════════════════ */}
      <div className="aurea-card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
          <Clock className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
          <div>
            <h2 className="aurea-display text-[18px] text-aurea-ink">Recent AI Activity</h2>
            <p className="text-[12px] text-aurea-ink-3">Latest AI actions and escalations</p>
          </div>
        </div>
        <div className="p-5">
          {recentActivities.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-aurea-ink-3">No recent AI activity</p>
          ) : (
            <div className="space-y-2">
              {recentActivities.map((activity: {
                id: string
                activity_type: string
                title: string
                description: string
                created_at: string
                metadata: Record<string, unknown>
                lead: { first_name: string; last_name: string } | null
              }) => {
                const isEscalation = activity.activity_type.includes('escalat')
                const isAutoResponse = activity.activity_type.includes('auto')
                const isModeChange = activity.activity_type === 'ai_mode_changed'

                return (
                  <div
                    key={activity.id}
                    className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
                      isEscalation
                        ? 'border-aurea-amber/30 bg-aurea-amber/[0.04]'
                        : 'border-aurea-border hover:bg-aurea-surface-2'
                    }`}
                  >
                    <div className={`mt-0.5 shrink-0 flex h-6 w-6 items-center justify-center rounded-full ${
                      isEscalation ? 'bg-aurea-amber/10 text-aurea-amber' :
                      isAutoResponse ? 'bg-aurea-primary/10 text-aurea-primary' :
                      isModeChange ? 'bg-aurea-surface-2 text-aurea-ink-2' :
                      'bg-aurea-surface-2 text-aurea-ink-3'
                    }`}>
                      {isEscalation ? <AlertTriangle className="h-3 w-3" strokeWidth={1.75} /> :
                       isAutoResponse ? <Bot className="h-3 w-3" strokeWidth={1.75} /> :
                       isModeChange ? <BrainCircuit className="h-3 w-3" strokeWidth={1.75} /> :
                       <Activity className="h-3 w-3" strokeWidth={1.75} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-aurea-ink truncate">{activity.title}</span>
                        {activity.lead && (
                          <span className="text-[12px] text-aurea-ink-3 shrink-0">
                            — {activity.lead.first_name} {activity.lead.last_name}
                          </span>
                        )}
                      </div>
                      {activity.description && (
                        <p className="text-[11.5px] text-aurea-ink-3 truncate mt-0.5">{activity.description}</p>
                      )}
                    </div>
                    <span className="font-mono text-[11px] text-aurea-ink-3 shrink-0">
                      {formatDistanceToNow(new Date(activity.created_at), { addSuffix: true })}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {!isAdmin && (
        <div className="flex items-center justify-center gap-2 py-4 text-[13px] text-aurea-ink-3">
          <Shield className="h-4 w-4" strokeWidth={1.75} />
          Admin access required to modify AI controls
        </div>
      )}
    </div>
  )
}
