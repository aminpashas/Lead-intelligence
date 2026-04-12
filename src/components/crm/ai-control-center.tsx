'use client'

import { useState, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
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
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">AI Control Center</h1>
          <p className="text-muted-foreground">
            Control when and how your AI agents operate — per conversation, per lead, or globally
          </p>
        </div>
        {pendingEscalations > 0 && (
          <Badge variant="destructive" className="gap-1 text-sm px-3 py-1">
            <AlertTriangle className="h-3.5 w-3.5" />
            {pendingEscalations} pending escalation{pendingEscalations > 1 ? 's' : ''}
          </Badge>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════
          A. MASTER CONTROLS
          ═══════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Kill Switch */}
        <Card className={`border-2 ${isPaused ? 'border-red-500 bg-red-50/50 dark:bg-red-950/20' : isEnabled ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20' : 'border-gray-300'}`}>
          <CardContent className="pt-6 text-center space-y-4">
            <div className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center ${
              isPaused ? 'bg-red-100 dark:bg-red-900/50' : isEnabled ? 'bg-emerald-100 dark:bg-emerald-900/50' : 'bg-gray-100 dark:bg-gray-800'
            }`}>
              {isPaused ? (
                <Pause className="h-8 w-8 text-red-600" />
              ) : isEnabled ? (
                <Play className="h-8 w-8 text-emerald-600" />
              ) : (
                <Power className="h-8 w-8 text-gray-500" />
              )}
            </div>
            <div>
              <h3 className="font-semibold text-lg">
                {isPaused ? 'AI Paused' : isEnabled ? 'AI Active' : 'AI Disabled'}
              </h3>
              <p className="text-sm text-muted-foreground">
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
                  {killSwitching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                  KILL SWITCH — Pause All AI
                </Button>
              ) : isPaused ? (
                <Button
                  className="w-full gap-2 bg-emerald-600 hover:bg-emerald-700"
                  onClick={handleResume}
                  disabled={saving || !isAdmin}
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Resume AI
                </Button>
              ) : null}
              <div className="flex items-center justify-center gap-3">
                <span className="text-sm text-muted-foreground">AI Enabled</span>
                <Switch
                  checked={isEnabled}
                  onCheckedChange={() => handleToggleEnabled()}
                  disabled={saving || !isAdmin}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Mode */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BrainCircuit className="h-4 w-4" />
              Operating Mode
            </CardTitle>
            <CardDescription>How should the AI handle responses?</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
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
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/20'
                    : 'border-border hover:bg-accent'
                }`}
              >
                <m.icon className={`h-5 w-5 ${mode === m.value ? 'text-primary' : 'text-muted-foreground'}`} />
                <div>
                  <span className={`text-sm font-medium ${mode === m.value ? 'text-primary' : ''}`}>{m.label}</span>
                  <p className="text-xs text-muted-foreground">{m.desc}</p>
                </div>
              </button>
            ))}
          </CardContent>
        </Card>

        {/* Quick Stats */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Live Overview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/30">
                <div className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">{aiAutoCount}</div>
                <div className="text-[10px] text-muted-foreground font-medium">AI Auto</div>
              </div>
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30">
                <div className="text-2xl font-bold text-amber-700 dark:text-amber-300">{aiAssistCount}</div>
                <div className="text-[10px] text-muted-foreground font-medium">AI Assist</div>
              </div>
              <div className="p-3 rounded-lg bg-gray-50 dark:bg-gray-900">
                <div className="text-2xl font-bold text-gray-700 dark:text-gray-300">{aiOffCount}</div>
                <div className="text-[10px] text-muted-foreground font-medium">Human Only</div>
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Total Conversations</span>
                <span className="font-medium">{conversations.length}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Pending Escalations</span>
                <span className={`font-medium ${pendingEscalations > 0 ? 'text-red-600' : ''}`}>
                  {pendingEscalations}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Speed-to-Lead</span>
                <Switch
                  checked={settings.autopilot_speed_to_lead ?? true}
                  onCheckedChange={(v) => saveSettings({ autopilot_speed_to_lead: v })}
                  disabled={!isAdmin}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ═══════════════════════════════════════════════════
          B. SCHEDULE & HYBRID MODE
          ═══════════════════════════════════════════════════ */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                Weekly Schedule — Hybrid Mode
              </CardTitle>
              <CardDescription>
                Set which days and hours the AI should operate. Outside these hours, a human handles conversations.
              </CardDescription>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">Custom Schedule</span>
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
          {/* Quick presets */}
          {scheduleEnabled && (
            <div className="flex gap-2 mt-3">
              {[
                { label: '24/7', fn: () => setSchedule(Object.fromEntries(DAY_LABELS.map(d => [d.key, { enabled: true, start: 0, end: 24 }])) as WeekSchedule) },
                { label: 'Business Hours', fn: () => setSchedule(DEFAULT_SCHEDULE) },
                { label: 'Weekdays Only', fn: () => setSchedule(Object.fromEntries(DAY_LABELS.map(d => [d.key, { enabled: !['saturday', 'sunday'].includes(d.key), start: 8, end: 21 }])) as WeekSchedule) },
              ].map((preset) => (
                <Button key={preset.label} variant="outline" size="sm" className="text-xs" onClick={preset.fn}>
                  {preset.label}
                </Button>
              ))}
              <Button variant="default" size="sm" className="text-xs ml-auto gap-1" onClick={saveSchedule} disabled={saving}>
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Save Schedule
              </Button>
            </div>
          )}
        </CardHeader>
        {scheduleEnabled && (
          <CardContent>
            <div className="space-y-2">
              {DAY_LABELS.map((day) => {
                const d = schedule[day.key]
                return (
                  <div
                    key={day.key}
                    className={`flex items-center gap-4 p-3 rounded-lg border transition-all ${
                      d.enabled ? 'bg-background' : 'bg-muted/50 opacity-60'
                    }`}
                  >
                    <div className="w-20">
                      <span className="font-medium text-sm">{day.short}</span>
                    </div>
                    <Switch
                      checked={d.enabled}
                      onCheckedChange={(v) => updateDaySchedule(day.key, 'enabled', v)}
                      disabled={!isAdmin}
                    />
                    {d.enabled ? (
                      <>
                        <div className="flex items-center gap-2 text-sm">
                          <Select value={String(d.start)} onValueChange={(v) => v && updateDaySchedule(day.key, 'start', parseInt(v))}>
                            <SelectTrigger className="w-20 h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {Array.from({ length: 24 }, (_, i) => (
                                <SelectItem key={i} value={String(i)}>{`${i}:00`}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <span className="text-muted-foreground">to</span>
                          <Select value={String(d.end)} onValueChange={(v) => v && updateDaySchedule(day.key, 'end', parseInt(v))}>
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
                        <Select value={d.mode || 'full'} onValueChange={(v) => v && updateDaySchedule(day.key, 'mode', v)}>
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
                        <div className="flex-1 h-6 bg-muted rounded-full overflow-hidden relative">
                          <div
                            className="h-full bg-emerald-500/30 absolute"
                            style={{
                              left: `${(d.start / 24) * 100}%`,
                              width: `${((d.end - d.start) / 24) * 100}%`,
                            }}
                          />
                          <div className="absolute inset-0 flex items-center justify-center text-[9px] text-muted-foreground font-medium">
                            {d.end - d.start}h active
                          </div>
                        </div>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">AI off — human only</span>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        )}
      </Card>

      {/* ═══════════════════════════════════════════════════
          C. CONFIDENCE & SAFETY
          ═══════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Confidence & Safety
            </CardTitle>
            <CardDescription>Fine-tune when AI sends automatically vs escalates to a human</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Confidence threshold */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Confidence Threshold</label>
                <span className="text-sm font-mono text-primary">
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
              <p className="text-xs text-muted-foreground">
                Below this confidence, AI drafts are sent for human review instead of auto-sending
              </p>
            </div>

            {/* Max messages per hour */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Max Messages / Hour</label>
                <span className="text-sm font-mono">{settings.autopilot_max_messages_per_hour ?? 10}</span>
              </div>
              <Slider
                value={[settings.autopilot_max_messages_per_hour ?? 10]}
                min={1}
                max={30}
                step={1}
                onValueCommit={(v) => saveSettings({ autopilot_max_messages_per_hour: v[0] })}
                disabled={!isAdmin}
              />
              <p className="text-xs text-muted-foreground">
                Per conversation rate limit to prevent spam
              </p>
            </div>

            {/* Response delay */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Response Delay Range</label>
              <div className="flex items-center gap-3">
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Min (seconds)</span>
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
                <span className="text-muted-foreground pt-5">—</span>
                <div className="space-y-1">
                  <span className="text-xs text-muted-foreground">Max (seconds)</span>
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
              <p className="text-xs text-muted-foreground">
                AI waits a random delay in this range before responding (feels more human)
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Stop Words */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              Stop Words (Opt-Out Detection)
            </CardTitle>
            <CardDescription>When a lead sends any of these words, AI stops and the lead is opted out</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
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
                <Badge key={word} variant="secondary" className="gap-1 pr-1">
                  {word}
                  <button
                    onClick={() => removeStopWord(word)}
                    className="ml-1 rounded-full hover:bg-destructive/20 p-0.5"
                    disabled={!isAdmin}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ═══════════════════════════════════════════════════
          D. ACTIVE CONVERSATIONS MONITOR
          ═══════════════════════════════════════════════════ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Active Conversations — AI Status
          </CardTitle>
          <CardDescription>Monitor and control AI mode for every active conversation</CardDescription>
        </CardHeader>
        <CardContent>
          {conversations.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No active conversations
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left pb-2 font-medium">Lead</th>
                    <th className="text-left pb-2 font-medium">Channel</th>
                    <th className="text-left pb-2 font-medium">Agent</th>
                    <th className="text-left pb-2 font-medium">AI Mode</th>
                    <th className="text-left pb-2 font-medium">Last Message</th>
                    <th className="text-left pb-2 font-medium">Lead Override</th>
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
                    <tr key={convo.id} className="border-b last:border-0 hover:bg-accent/50 transition-colors">
                      <td className="py-2.5">
                        <div className="font-medium">
                          {convo.lead?.first_name} {convo.lead?.last_name}
                        </div>
                        <div className="text-xs text-muted-foreground">{convo.lead?.status}</div>
                      </td>
                      <td className="py-2.5">
                        <Badge variant="outline" className="text-xs">{convo.channel}</Badge>
                      </td>
                      <td className="py-2.5">
                        <Badge variant="outline" className={`text-xs ${
                          convo.active_agent === 'setter' ? 'bg-blue-50 text-blue-700 border-blue-200'
                          : convo.active_agent === 'closer' ? 'bg-purple-50 text-purple-700 border-purple-200'
                          : 'bg-gray-50 text-gray-600'
                        }`}>
                          {convo.active_agent || 'none'}
                        </Badge>
                      </td>
                      <td className="py-2.5">
                        <AIModeToggle
                          conversationId={convo.id}
                          currentMode={convo.ai_mode || 'off'}
                          size="sm"
                          showLabel={false}
                        />
                      </td>
                      <td className="py-2.5">
                        <span className="text-xs text-muted-foreground">
                          {convo.last_message_at
                            ? formatDistanceToNow(new Date(convo.last_message_at), { addSuffix: true })
                            : '—'}
                        </span>
                      </td>
                      <td className="py-2.5">
                        <Badge variant="outline" className="text-[10px]">
                          {convo.lead?.ai_autopilot_override || 'default'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {conversations.length > 25 && (
                <p className="text-xs text-muted-foreground text-center mt-3">
                  Showing 25 of {conversations.length} conversations
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ═══════════════════════════════════════════════════
          E. RECENT AI ACTIVITY FEED
          ═══════════════════════════════════════════════════ */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Recent AI Activity
          </CardTitle>
          <CardDescription>Latest AI actions and escalations</CardDescription>
        </CardHeader>
        <CardContent>
          {recentActivities.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              No recent AI activity
            </div>
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
                    className={`flex items-start gap-3 p-3 rounded-lg border transition-colors ${
                      isEscalation ? 'border-amber-200 bg-amber-50/50 dark:bg-amber-950/20' : 'hover:bg-accent/30'
                    }`}
                  >
                    <div className={`mt-0.5 p-1.5 rounded-full ${
                      isEscalation ? 'bg-amber-100 text-amber-700' :
                      isAutoResponse ? 'bg-emerald-100 text-emerald-700' :
                      isModeChange ? 'bg-blue-100 text-blue-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {isEscalation ? <AlertTriangle className="h-3 w-3" /> :
                       isAutoResponse ? <Bot className="h-3 w-3" /> :
                       isModeChange ? <BrainCircuit className="h-3 w-3" /> :
                       <Activity className="h-3 w-3" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{activity.title}</span>
                        {activity.lead && (
                          <span className="text-xs text-muted-foreground shrink-0">
                            — {activity.lead.first_name} {activity.lead.last_name}
                          </span>
                        )}
                      </div>
                      {activity.description && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{activity.description}</p>
                      )}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDistanceToNow(new Date(activity.created_at), { addSuffix: true })}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {!isAdmin && (
        <div className="text-center py-4 text-sm text-muted-foreground">
          <Shield className="h-4 w-4 inline-block mr-1" />
          Admin access required to modify AI controls
        </div>
      )}
    </div>
  )
}
