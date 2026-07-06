'use client'

import { useMemo, useState } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import {
  Calendar,
  Loader2,
  Stethoscope,
  Repeat,
  ScanLine,
  Activity,
  MoreHorizontal,
  Building2,
  Video,
  Clock,
  Timer,
  Check,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { Lead } from '@/types/database'

const APPT_TYPES = [
  { value: 'consultation', label: 'Consultation', icon: Stethoscope },
  { value: 'follow_up', label: 'Follow Up', icon: Repeat },
  { value: 'scan', label: 'CT Scan', icon: ScanLine },
  { value: 'treatment', label: 'Treatment', icon: Activity },
  { value: 'other', label: 'Other', icon: MoreHorizontal },
] as const

const DURATIONS = [
  { value: '30', label: '30m' },
  { value: '60', label: '1 hr' },
  { value: '90', label: '1.5 hr' },
  { value: '120', label: '2 hr' },
] as const

// Common clinic slots, stored as 24h "HH:MM" to match <input type="time">.
const TIME_SLOTS = ['08:00', '09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00']

function toLocalKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function labelFor12h(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number)
  if (Number.isNaN(h)) return ''
  const period = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

/** Chip / segmented control — the one interactive primitive used throughout. */
function Chip({
  selected,
  onClick,
  className,
  children,
}: {
  selected: boolean
  onClick: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] font-medium transition-all outline-none focus-visible:ring-2 focus-visible:ring-aurea-primary/30',
        selected
          ? 'border-aurea-primary bg-aurea-primary/10 text-aurea-ink ring-1 ring-aurea-primary/30'
          : 'border-aurea-border bg-aurea-surface text-aurea-ink-2 hover:border-aurea-border-strong hover:bg-aurea-surface-2 hover:text-aurea-ink',
        className
      )}
    >
      {children}
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="aurea-eyebrow mb-2">{children}</p>
}

export function ScheduleAppointment({ lead }: { lead: Lead }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [type, setType] = useState<string>('consultation')
  const [date, setDate] = useState(() => toLocalKey(new Date()))
  const [time, setTime] = useState('10:00')
  const [duration, setDuration] = useState('60')
  const [location, setLocation] = useState('')
  const [notes, setNotes] = useState('')
  const router = useRouter()

  // Next 6 days as quick-pick chips (Today / Tomorrow / weekday).
  const dayChips = useMemo(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return Array.from({ length: 6 }, (_, i) => {
      const d = new Date(today)
      d.setDate(today.getDate() + i)
      const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short' })
      const sub = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      return { key: toLocalKey(d), label, sub }
    })
  }, [])

  const summary = useMemo(() => {
    if (!date || !time) return null
    const d = new Date(`${date}T${time}`)
    if (Number.isNaN(d.getTime())) return null
    const typeLabel = APPT_TYPES.find((t) => t.value === type)?.label ?? 'Appointment'
    const durLabel = DURATIONS.find((x) => x.value === duration)?.label ?? `${duration}m`
    const dateStr = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    return `${typeLabel} · ${dateStr} · ${labelFor12h(time)} · ${durLabel}`
  }, [date, time, type, duration])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!date || !time) { toast.error('Date and time are required'); return }

    setSaving(true)
    try {
      const scheduledAt = new Date(`${date}T${time}`).toISOString()

      const res = await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: lead.id,
          type,
          scheduled_at: scheduledAt,
          duration_minutes: parseInt(duration),
          location: location || undefined,
          notes: notes || undefined,
        }),
      })

      if (!res.ok) throw new Error('Failed to schedule')

      toast.success('Appointment scheduled!')
      setOpen(false)
      router.refresh()
    } catch {
      toast.error('Failed to schedule appointment')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<button type="button" className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-aurea-border bg-aurea-surface px-3 py-2 text-[13.5px] font-medium text-aurea-ink transition-colors hover:bg-aurea-surface-2" />}>
        <Calendar className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
        Schedule
      </DialogTrigger>

      {/* `aurea` on the popup itself: the dialog portals to <body>, outside the
          app's `.aurea` wrapper, so the emerald/gold tokens are undefined there.
          Re-declaring the class here makes every aurea-* utility resolve inside
          the modal (and `.dark .aurea` still flips for dark mode). */}
      <DialogContent className="aurea gap-0 overflow-hidden p-0 sm:max-w-md">
        {/* Header — editorial, with a hairline rule under it */}
        <DialogHeader className="gap-1 border-b border-aurea-border px-5 pt-5 pb-4">
          <p className="aurea-eyebrow">New Appointment</p>
          <DialogTitle className="aurea-display text-[24px] font-normal text-aurea-ink">
            {lead.first_name} {lead.last_name}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="max-h-[min(70vh,560px)] space-y-5 overflow-y-auto px-5 py-5">
            {/* Type */}
            <div>
              <SectionLabel>Type</SectionLabel>
              <div className="flex flex-wrap gap-2">
                {APPT_TYPES.map((t) => {
                  const Icon = t.icon
                  const active = type === t.value
                  return (
                    <Chip key={t.value} selected={active} onClick={() => setType(t.value)}>
                      <Icon
                        className={cn('h-[15px] w-[15px]', active ? 'text-aurea-primary' : 'text-aurea-ink-3')}
                        strokeWidth={1.75}
                      />
                      {t.label}
                    </Chip>
                  )
                })}
              </div>
            </div>

            {/* Date */}
            <div>
              <SectionLabel>Date</SectionLabel>
              <div className="grid grid-cols-3 gap-2">
                {dayChips.map((d) => (
                  <Chip
                    key={d.key}
                    selected={date === d.key}
                    onClick={() => setDate(d.key)}
                    className="flex-col gap-0.5 py-2.5"
                  >
                    <span className="text-[13px] leading-none">{d.label}</span>
                    <span className={cn('text-[11px] leading-none', date === d.key ? 'text-aurea-ink-2' : 'text-aurea-ink-3')}>
                      {d.sub}
                    </span>
                  </Chip>
                ))}
              </div>
              <label className="mt-2 flex items-center gap-2 rounded-lg border border-aurea-border bg-aurea-surface px-3 py-2 text-[13px] text-aurea-ink-2 focus-within:border-aurea-border-strong">
                <Calendar className="h-4 w-4 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
                <span className="shrink-0">Or pick a date</span>
                <Input
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  min={toLocalKey(new Date())}
                  className="h-auto flex-1 border-0 bg-transparent p-0 text-right text-aurea-ink shadow-none focus-visible:ring-0"
                />
              </label>
            </div>

            {/* Time */}
            <div>
              <SectionLabel>Time</SectionLabel>
              <div className="grid grid-cols-4 gap-2">
                {TIME_SLOTS.map((slot) => (
                  <Chip key={slot} selected={time === slot} onClick={() => setTime(slot)} className="px-2">
                    {labelFor12h(slot)}
                  </Chip>
                ))}
              </div>
              <label className="mt-2 flex items-center gap-2 rounded-lg border border-aurea-border bg-aurea-surface px-3 py-2 text-[13px] text-aurea-ink-2 focus-within:border-aurea-border-strong">
                <Clock className="h-4 w-4 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
                <span className="shrink-0">Or set a time</span>
                <Input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="h-auto flex-1 border-0 bg-transparent p-0 text-right text-aurea-ink shadow-none focus-visible:ring-0"
                />
              </label>
            </div>

            {/* Duration */}
            <div>
              <SectionLabel>Duration</SectionLabel>
              <div className="inline-flex w-full rounded-lg border border-aurea-border p-1">
                {DURATIONS.map((d) => (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => setDuration(d.value)}
                    aria-pressed={duration === d.value}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[13px] font-medium transition-all outline-none',
                      duration === d.value
                        ? 'bg-aurea-primary/10 text-aurea-ink ring-1 ring-aurea-primary/30'
                        : 'text-aurea-ink-3 hover:text-aurea-ink'
                    )}
                  >
                    {duration === d.value && <Timer className="h-3.5 w-3.5 text-aurea-primary" strokeWidth={2} />}
                    {d.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Location */}
            <div>
              <SectionLabel>Location</SectionLabel>
              <div className="mb-2 flex gap-2">
                <Chip selected={location === 'In-office'} onClick={() => setLocation('In-office')}>
                  <Building2 className="h-[15px] w-[15px] text-aurea-ink-3" strokeWidth={1.75} />
                  In-office
                </Chip>
                <Chip selected={location === 'Virtual'} onClick={() => setLocation('Virtual')}>
                  <Video className="h-[15px] w-[15px] text-aurea-ink-3" strokeWidth={1.75} />
                  Virtual
                </Chip>
              </div>
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Or type a custom location…"
              />
            </div>

            {/* Notes */}
            <div>
              <SectionLabel>Notes</SectionLabel>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Any special instructions…"
              />
            </div>
          </div>

          {/* Footer — live summary + actions */}
          <div className="border-t border-aurea-border bg-aurea-surface-2/50 px-5 py-4">
            {summary && (
              <div className="mb-3 flex items-start gap-2">
                <span className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-aurea-primary/15">
                  <Check className="h-2.5 w-2.5 text-aurea-primary" strokeWidth={3} />
                </span>
                <p className="text-[13px] leading-snug text-aurea-ink-2">{summary}</p>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving} className="gap-1.5">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Schedule
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
