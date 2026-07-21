'use client'

/**
 * Live-Transfer settings — arm the AI bulk dialer's human handoff, manage the
 * "live people" it forwards to, and the time-of-day routing between them.
 *
 * All reads/writes go through /api/voice/transfer-config. The master switch is
 * the "only when we turn it on" gate; below it, targets are the humans and routes
 * decide who's on call by day + hour (business hours → staff, off-hours → concierge,
 * overflow → spillover).
 */

import { useEffect, useState, useCallback } from 'react'
import { toast } from 'sonner'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import type { VoiceTransferTarget, VoiceTransferRoute, VoiceAgentPresence } from '@/types/database'

type ConfigResponse = {
  org: {
    voice_live_transfer_enabled: boolean
    voice_live_transfer_max_hold_seconds: number
    inbound_call_mode: 'ai' | 'ring_agents'
    inbound_ai_on_no_answer: boolean
    inbound_ai_after_hours: boolean
    inbound_ring_seconds: number
    inbound_voicemail_greeting: string | null
  }
  targets: VoiceTransferTarget[]
  routes: VoiceTransferRoute[]
  presence: Pick<VoiceAgentPresence, 'target_id' | 'status' | 'active_calls'>[]
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const KIND_LABEL: Record<string, string> = { phone: 'Phone', sip: 'SIP', softphone_user: 'In-app rep' }
// Base UI's <SelectValue> renders the raw value, so map each value → trigger label.
const KIND_SELECT_LABELS: Record<string, string> = { phone: 'Phone number', sip: 'SIP address', softphone_user: 'In-app rep' }

export function LiveTransferSettings({ canAdmin }: { canAdmin: boolean }) {
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch('/api/voice/transfer-config')
    if (res.ok) setConfig(await res.json())
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const mutate = useCallback(async (payload: Record<string, unknown>): Promise<boolean> => {
    setSaving(true)
    const res = await fetch('/api/voice/transfer-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setSaving(false)
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Failed' }))
      toast.error(error || 'Failed')
      return false
    }
    await load()
    return true
  }, [load])

  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>
  if (!config) return <div className="text-sm text-destructive">Could not load settings.</div>

  const presenceFor = (id: string) => config.presence.find(p => p.target_id === id)

  return (
    <div className="space-y-6">
      {/* Master switch */}
      <Card>
        <CardHeader>
          <CardTitle>AI bulk calling → live transfer</CardTitle>
          <CardDescription>
            When on, active live-transfer campaigns dial leads with the AI, and forward each answered
            call to an available person below. The AI keeps the caller engaged until someone is free.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">Enable live transfer</div>
              <div className="text-sm text-muted-foreground">Master switch for this organization.</div>
            </div>
            <Switch
              checked={config.org.voice_live_transfer_enabled}
              disabled={!canAdmin || saving}
              onCheckedChange={(v) => mutate({ action: 'set_org', enabled: v })}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-medium">Max hold time</div>
              <div className="text-sm text-muted-foreground">
                Longest the AI will keep a caller engaged waiting for a rep before wrapping up gracefully.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                className="w-24"
                min={30}
                max={600}
                defaultValue={config.org.voice_live_transfer_max_hold_seconds}
                disabled={!canAdmin || saving}
                onBlur={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (v && v !== config.org.voice_live_transfer_max_hold_seconds) {
                    mutate({ action: 'set_org', max_hold_seconds: v })
                  }
                }}
              />
              <span className="text-sm text-muted-foreground">sec</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Inbound call handling */}
      <Card>
        <CardHeader>
          <CardTitle>Inbound calls</CardTitle>
          <CardDescription>
            Who answers when a patient calls the practice number. Ringing uses the people and
            business-hours routes below; the AI covers whatever you leave to it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-medium">Answer mode</div>
              <div className="text-sm text-muted-foreground">
                {config.org.inbound_call_mode === 'ring_agents'
                  ? 'Calls ring your team first (in-app softphones and forwarding numbers).'
                  : 'The AI answers every call immediately.'}
              </div>
            </div>
            <Select
              value={config.org.inbound_call_mode}
              disabled={!canAdmin || saving}
              onValueChange={(v) => { if (v) mutate({ action: 'set_org', inbound_call_mode: v }) }}
            >
              <SelectTrigger className="w-44">
                <SelectValue>
                  {config.org.inbound_call_mode === 'ring_agents' ? 'Ring the team first' : 'AI answers'}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ai">AI answers</SelectItem>
                <SelectItem value="ring_agents">Ring the team first</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {config.org.inbound_call_mode === 'ring_agents' && (
            <>
              <Separator />
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium">Ring time</div>
                  <div className="text-sm text-muted-foreground">
                    How long the team&apos;s phones ring before the fallback takes over.
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    className="w-24"
                    min={5}
                    max={60}
                    defaultValue={config.org.inbound_ring_seconds}
                    disabled={!canAdmin || saving}
                    onBlur={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (v && v !== config.org.inbound_ring_seconds) {
                        mutate({ action: 'set_org', inbound_ring_seconds: v })
                      }
                    }}
                  />
                  <span className="text-sm text-muted-foreground">sec</span>
                </div>
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">AI takes over when nobody answers</div>
                  <div className="text-sm text-muted-foreground">
                    Off = missed calls go to voicemail (manual process).
                  </div>
                </div>
                <Switch
                  checked={config.org.inbound_ai_on_no_answer}
                  disabled={!canAdmin || saving}
                  onCheckedChange={(v) => mutate({ action: 'set_org', inbound_ai_on_no_answer: v })}
                />
              </div>
              <Separator />
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium">AI answers after hours</div>
                  <div className="text-sm text-muted-foreground">
                    Outside every routing window below. Off = after-hours callers go to voicemail.
                  </div>
                </div>
                <Switch
                  checked={config.org.inbound_ai_after_hours}
                  disabled={!canAdmin || saving}
                  onCheckedChange={(v) => mutate({ action: 'set_org', inbound_ai_after_hours: v })}
                />
              </div>
              <Separator />
              <div className="space-y-1.5">
                <Label htmlFor="vm-greeting" className="font-medium">Voicemail greeting</Label>
                <p className="text-sm text-muted-foreground">
                  Spoken before the beep. Leave blank for a standard greeting with your practice name.
                </p>
                <Input
                  id="vm-greeting"
                  placeholder="Thank you for calling… please leave a message."
                  defaultValue={config.org.inbound_voicemail_greeting ?? ''}
                  disabled={!canAdmin || saving}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v !== (config.org.inbound_voicemail_greeting ?? '')) {
                      mutate({ action: 'set_org', inbound_voicemail_greeting: v })
                    }
                  }}
                />
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <TargetsCard
        targets={config.targets}
        presenceFor={presenceFor}
        canAdmin={canAdmin}
        saving={saving}
        onSave={(t) => mutate({ action: 'save_target', ...t })}
        onDelete={(id) => mutate({ action: 'delete_target', id })}
        onDuty={(target_id, on_duty) => mutate({ action: 'set_duty', target_id, on_duty })}
        onPatientRoute={(target_id, on) => mutate({ action: 'set_patient_route', target_id, existing_patient_route: on })}
      />

      <RoutesCard
        routes={config.routes}
        targets={config.targets}
        canAdmin={canAdmin}
        saving={saving}
        onSave={(r) => mutate({ action: 'save_route', ...r })}
        onDelete={(id) => mutate({ action: 'delete_route', id })}
      />
    </div>
  )
}

// ── Targets ──────────────────────────────────────────────────
function TargetsCard(props: {
  targets: VoiceTransferTarget[]
  presenceFor: (id: string) => { status: string; active_calls: number } | undefined
  canAdmin: boolean
  saving: boolean
  onSave: (t: Record<string, unknown>) => Promise<boolean>
  onDelete: (id: string) => void
  onDuty: (id: string, onDuty: boolean) => void
  onPatientRoute: (id: string, on: boolean) => void
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState('phone')
  const [destination, setDestination] = useState('')
  const [maxConcurrent, setMaxConcurrent] = useState(1)
  const [patientRoute, setPatientRoute] = useState(false)

  const isPatientRoute = (t: VoiceTransferTarget) =>
    (t.metadata as { purpose?: string } | null)?.purpose === 'existing_patient'

  const submit = async () => {
    const ok = await props.onSave({ name, kind, destination, max_concurrent: maxConcurrent, existing_patient_route: patientRoute })
    if (ok) { setAdding(false); setName(''); setDestination(''); setKind('phone'); setMaxConcurrent(1); setPatientRoute(false) }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Who calls get forwarded to</CardTitle>
        <CardDescription>The live people (or a concierge/answering service number) an answered call can reach.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.targets.length === 0 && <div className="text-sm text-muted-foreground">No targets yet.</div>}
        {props.targets.map((t) => {
          const p = props.presenceFor(t.id)
          return (
            <div key={t.id} className="flex items-center justify-between rounded-md border p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{t.name}</span>
                  <Badge variant="secondary">{KIND_LABEL[t.kind] || t.kind}</Badge>
                  {isPatientRoute(t) && <Badge>Existing-patient route</Badge>}
                  {p && (
                    <Badge variant={p.status === 'available' ? 'default' : p.status === 'on_call' ? 'destructive' : 'outline'}>
                      {p.status === 'on_call' ? `on call (${p.active_calls})` : p.status}
                    </Badge>
                  )}
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  {t.kind === 'softphone_user' ? 'In-app rep' : t.destination} · up to {t.max_concurrent} at once
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                {props.canAdmin && (
                  <div className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground">Patients</Label>
                    <Switch checked={isPatientRoute(t)} disabled={props.saving} onCheckedChange={(v) => props.onPatientRoute(t.id, v)} />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">On duty</Label>
                  <Switch checked={t.on_duty} disabled={props.saving} onCheckedChange={(v) => props.onDuty(t.id, v)} />
                </div>
                {props.canAdmin && (
                  <Button variant="ghost" size="sm" disabled={props.saving} onClick={() => props.onDelete(t.id)}>Remove</Button>
                )}
              </div>
            </div>
          )
        })}

        {props.canAdmin && (adding ? (
          <div className="space-y-3 rounded-md border border-dashed p-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Front desk" />
              </div>
              <div className="space-y-1">
                <Label>Type</Label>
                <Select items={KIND_SELECT_LABELS} value={kind} onValueChange={(v) => setKind(v || 'phone')}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="phone">Phone number</SelectItem>
                    <SelectItem value="sip">SIP address</SelectItem>
                    <SelectItem value="softphone_user">In-app rep</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {kind !== 'softphone_user' && (
                <div className="space-y-1">
                  <Label>{kind === 'sip' ? 'SIP address' : 'Phone number'}</Label>
                  <Input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="+14155551234" />
                </div>
              )}
              <div className="space-y-1">
                <Label>Simultaneous calls</Label>
                <Input type="number" min={1} value={maxConcurrent} onChange={(e) => setMaxConcurrent(parseInt(e.target.value, 10) || 1)} />
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-md border border-dashed p-2">
              <Switch checked={patientRoute} disabled={props.saving} onCheckedChange={setPatientRoute} />
              <div className="space-y-0.5">
                <Label className="text-sm">Office manager for existing patients</Label>
                <p className="text-xs text-muted-foreground">
                  Patients already in active treatment who call in ring this person first (instead of the sales AI). Only one target can hold this.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={submit} disabled={props.saving}>Add</Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>Add a target</Button>
        ))}
      </CardContent>
    </Card>
  )
}

// ── Routes ───────────────────────────────────────────────────
function RoutesCard(props: {
  routes: VoiceTransferRoute[]
  targets: VoiceTransferTarget[]
  canAdmin: boolean
  saving: boolean
  onSave: (r: Record<string, unknown>) => Promise<boolean>
  onDelete: (id: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [startHour, setStartHour] = useState(9)
  const [endHour, setEndHour] = useState(18)
  const [days, setDays] = useState<string[]>(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])
  const [targetIds, setTargetIds] = useState<string[]>([])
  const [isOverflow, setIsOverflow] = useState(false)

  const targetName = (id: string) => props.targets.find(t => t.id === id)?.name || '—'

  const submit = async () => {
    const ok = await props.onSave({
      name, start_hour: startHour, end_hour: endHour, active_days: days,
      target_ids: targetIds, is_overflow: isOverflow, priority: isOverflow ? 900 : 100,
    })
    if (ok) { setAdding(false); setName(''); setTargetIds([]); setIsOverflow(false) }
  }

  const toggleDay = (d: string) => setDays((cur) => cur.includes(d) ? cur.filter(x => x !== d) : [...cur, d])
  const toggleTarget = (id: string) => setTargetIds((cur) => cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id])

  return (
    <Card>
      <CardHeader>
        <CardTitle>Routing by time of day</CardTitle>
        <CardDescription>
          Which targets take calls, and when. Business hours → your staff; after hours → a concierge;
          add an overflow rule to spill over when everyone in-window is busy.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.routes.length === 0 && <div className="text-sm text-muted-foreground">No routes yet — calls won’t transfer until at least one exists.</div>}
        {props.routes.map((r) => (
          <div key={r.id} className="flex items-center justify-between rounded-md border p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium truncate">{r.name}</span>
                {r.is_overflow && <Badge variant="outline">overflow</Badge>}
              </div>
              <div className="text-sm text-muted-foreground truncate">
                {r.is_overflow ? 'When in-window targets are busy' : `${r.active_days.length} days · ${r.start_hour}:00–${r.end_hour}:00 ${r.timezone}`}
                {' · '}{r.target_ids.map(targetName).join(' → ') || 'no targets'}
              </div>
            </div>
            {props.canAdmin && (
              <Button variant="ghost" size="sm" disabled={props.saving} onClick={() => props.onDelete(r.id)}>Remove</Button>
            )}
          </div>
        ))}

        {props.canAdmin && (adding ? (
          <div className="space-y-3 rounded-md border border-dashed p-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Business hours" />
              </div>
              <div className="flex items-end gap-2">
                <div className="space-y-1">
                  <Label>From</Label>
                  <Input type="number" min={0} max={23} value={startHour} onChange={(e) => setStartHour(parseInt(e.target.value, 10) || 0)} />
                </div>
                <div className="space-y-1">
                  <Label>To</Label>
                  <Input type="number" min={1} max={24} value={endHour} onChange={(e) => setEndHour(parseInt(e.target.value, 10) || 0)} />
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Days</Label>
              <div className="flex flex-wrap gap-1">
                {DAYS.map((d) => (
                  <Button key={d} type="button" size="sm" variant={days.includes(d) ? 'default' : 'outline'} onClick={() => toggleDay(d)}>
                    {d.slice(0, 3)}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Targets (in order of preference)</Label>
              <div className="flex flex-wrap gap-1">
                {props.targets.map((t) => (
                  <Button key={t.id} type="button" size="sm" variant={targetIds.includes(t.id) ? 'default' : 'outline'} onClick={() => toggleTarget(t.id)}>
                    {t.name}{targetIds.includes(t.id) ? ` (${targetIds.indexOf(t.id) + 1})` : ''}
                  </Button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={isOverflow} onCheckedChange={setIsOverflow} />
              <Label className="text-sm">Overflow rule (used only when in-window targets are all busy)</Label>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={submit} disabled={props.saving || targetIds.length === 0}>Add route</Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>Add a route</Button>
        ))}
      </CardContent>
    </Card>
  )
}
