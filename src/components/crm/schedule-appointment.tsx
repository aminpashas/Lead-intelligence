'use client'

import { useEffect, useMemo, useState } from 'react'
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
  CreditCard,
  Search,
  UserRound,
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

// The minimal lead shape the booking form needs. `Lead` (lead-detail) and the
// appointments page's lighter `AppointmentLead` both satisfy it.
export type SchedulableLead = Pick<Lead, 'id' | 'first_name' | 'last_name'>

type LeadSearchResult = SchedulableLead & { phone?: string | null; email?: string | null }

export function ScheduleAppointment({
  lead: leadProp,
  mode = 'create',
  appointmentId,
  open: controlledOpen,
  onOpenChange,
  trigger,
  initial,
  onCompleted,
}: {
  /** Pre-provided lead. When omitted, the dialog opens on a patient picker first. */
  lead?: SchedulableLead | null
  /** `reschedule` pre-fills the current time and skips card-on-file prompts. */
  mode?: 'create' | 'reschedule'
  /** In `reschedule` mode, the id of the appointment to move in place (PATCH). */
  appointmentId?: string | null
  /** Optional controlled open state (lets a parent drive the dialog directly). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Custom trigger node. When omitted (and uncontrolled), renders the default "Schedule" chip. */
  trigger?: React.ReactNode
  /** Seed values applied on each open — used by reschedule to pre-fill the slot. */
  initial?: { type?: string; date?: string; time?: string; duration?: string; location?: string }
  /** Called after a successful save so the parent can refetch. */
  onCompleted?: (result: { lead: SchedulableLead; appointmentId?: string }) => void | Promise<void>
}) {
  const isControlled = controlledOpen !== undefined
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (o: boolean) => {
    if (!isControlled) setUncontrolledOpen(o)
    onOpenChange?.(o)
  }

  const [saving, setSaving] = useState(false)
  const [type, setType] = useState<string>('consultation')
  const [date, setDate] = useState(() => toLocalKey(new Date()))
  const [time, setTime] = useState('10:00')
  const [duration, setDuration] = useState('60')
  const [location, setLocation] = useState('')
  const [notes, setNotes] = useState('')
  // Standalone picker: the lead chosen inside the dialog when none was provided.
  const [pickedLead, setPickedLead] = useState<SchedulableLead | null>(null)
  const activeLead = leadProp ?? pickedLead
  // No-show card-on-file config, loaded when the dialog opens.
  const [feeEnabled, setFeeEnabled] = useState(false)
  const [feeDollars, setFeeDollars] = useState(50)
  const [cardRequired, setCardRequired] = useState(false)
  const [sendCardLink, setSendCardLink] = useState(true)
  const router = useRouter()

  // Reset the form each time the dialog (re)opens, seeding from `initial` — this
  // is what pre-fills the current slot when rescheduling. Runs on the open edge.
  useEffect(() => {
    if (!open) return
    setType(initial?.type ?? 'consultation')
    setDate(initial?.date ?? toLocalKey(new Date()))
    setTime(initial?.time ?? '10:00')
    setDuration(initial?.duration ?? '60')
    setLocation(initial?.location ?? '')
    setNotes('')
    if (!leadProp) setPickedLead(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Load the practice's no-show settings once the dialog is open, so we can show
  // the card-on-file control and know whether it's optional or mandatory.
  useEffect(() => {
    if (!open) return
    let active = true
    fetch('/api/settings/booking-protocol')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (!active) return
        setFeeEnabled(!!d.settings?.no_show_fee_enabled)
        setFeeDollars(Math.round((d.settings?.no_show_fee_cents ?? 5000) / 100))
        setCardRequired(!!d.settings?.card_on_file_required)
      })
      .catch(() => { /* non-fatal: control just won't show */ })
    return () => { active = false }
  }, [open])

  // The card link only applies to new consultations (matches the server gate);
  // a reschedule never re-prompts for a card.
  const showCard = feeEnabled && type === 'consultation' && mode === 'create'

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
    if (!activeLead) { toast.error('Select a patient first'); return }
    if (!date || !time) { toast.error('Date and time are required'); return }

    setSaving(true)
    try {
      const scheduledAt = new Date(`${date}T${time}`).toISOString()

      // Reschedule moves the existing appointment in place: one PATCH updates the
      // time (and any changed fields) and the server resets confirmation/reminders.
      if (mode === 'reschedule') {
        if (!appointmentId) { toast.error('Missing appointment to reschedule'); return }
        const res = await fetch('/api/appointments', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appointment_id: appointmentId,
            scheduled_at: scheduledAt,
            type,
            duration_minutes: parseInt(duration),
            location: location || undefined,
            notes: notes || undefined,
          }),
        })
        if (!res.ok) throw new Error('Failed to reschedule')
        toast.success('Appointment rescheduled')
        setOpen(false)
        await onCompleted?.({ lead: activeLead, appointmentId })
        router.refresh()
        return
      }

      const res = await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: activeLead.id,
          type,
          scheduled_at: scheduledAt,
          duration_minutes: parseInt(duration),
          location: location || undefined,
          notes: notes || undefined,
          // Optional mode: honour the rep's checkbox. Required/off modes ignore it.
          send_card_link: sendCardLink,
        }),
      })

      if (!res.ok) throw new Error('Failed to schedule')

      const data = await res.json().catch(() => ({}))
      if (data?.held) {
        toast.success('Slot held — the patient was texted a card link. It confirms once they save a card.')
      } else if (data?.card_link_sent) {
        toast.success('Appointment scheduled — card-on-file link texted to the patient.')
      } else {
        toast.success('Appointment scheduled!')
      }
      setOpen(false)
      await onCompleted?.({ lead: activeLead, appointmentId: data?.appointment?.id })
      router.refresh()
    } catch {
      toast.error(mode === 'reschedule' ? 'Failed to reschedule appointment' : 'Failed to schedule appointment')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* A parent can drive the dialog via `open`/`onOpenChange` and pass no
          trigger; otherwise render the given trigger or the default chip. */}
      {!isControlled && (
        trigger ? (
          <DialogTrigger>{trigger}</DialogTrigger>
        ) : (
          <DialogTrigger render={<button type="button" className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-aurea-border bg-aurea-surface px-3 py-2 text-[13.5px] font-medium text-aurea-ink transition-colors hover:bg-aurea-surface-2" />}>
            <Calendar className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
            Schedule
          </DialogTrigger>
        )
      )}

      {/* `aurea` on the popup itself: the dialog portals to <body>, outside the
          app's `.aurea` wrapper, so the emerald/gold tokens are undefined there.
          Re-declaring the class here makes every aurea-* utility resolve inside
          the modal (and `.dark .aurea` still flips for dark mode). */}
      <DialogContent className="aurea gap-0 overflow-hidden p-0 sm:max-w-md">
        {/* Header — editorial, with a hairline rule under it */}
        <DialogHeader className="gap-1 border-b border-aurea-border px-5 pt-5 pb-4">
          <p className="aurea-eyebrow">{mode === 'reschedule' ? 'Reschedule Appointment' : 'New Appointment'}</p>
          <DialogTitle className="aurea-display text-[24px] font-normal text-aurea-ink">
            {activeLead ? `${activeLead.first_name} ${activeLead.last_name ?? ''}`.trim() : 'Select a patient'}
          </DialogTitle>
        </DialogHeader>

        {!activeLead ? (
          <LeadPicker onPick={setPickedLead} />
        ) : (
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

            {/* No-show card-on-file */}
            {showCard && (
              <div>
                <SectionLabel>No-show protection</SectionLabel>
                {cardRequired ? (
                  <div className="flex items-start gap-2.5 rounded-lg border border-aurea-primary/25 bg-aurea-primary/5 px-3 py-2.5">
                    <CreditCard className="mt-px h-[17px] w-[17px] shrink-0 text-aurea-primary" strokeWidth={1.75} />
                    <p className="text-[13px] leading-snug text-aurea-ink-2">
                      A card on file is <span className="font-medium text-aurea-ink">required</span>. The patient
                      is texted a link now; the appointment confirms automatically once they save a card
                      (${feeDollars} charged only on a no-show).
                    </p>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSendCardLink((v) => !v)}
                    className="flex w-full items-start gap-2.5 rounded-lg border border-aurea-border bg-aurea-surface px-3 py-2.5 text-left transition-colors hover:bg-aurea-surface-2"
                  >
                    <span
                      className={cn(
                        'mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors',
                        sendCardLink ? 'border-aurea-primary bg-aurea-primary text-white' : 'border-aurea-border-strong bg-aurea-surface'
                      )}
                    >
                      {sendCardLink && <Check className="h-3 w-3" strokeWidth={3} />}
                    </span>
                    <span className="text-[13px] leading-snug text-aurea-ink-2">
                      <span className="font-medium text-aurea-ink">Text a card-on-file link</span> — the consult
                      is free; the ${feeDollars} fee is charged only if they miss the appointment without notice.
                    </span>
                  </button>
                )}
              </div>
            )}
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
                {mode === 'reschedule'
                  ? 'Reschedule'
                  : showCard && cardRequired
                  ? 'Hold & text card link'
                  : 'Schedule'}
              </Button>
            </div>
          </div>
        </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ═══════════════════════════════════════════════════════════════
// LEAD PICKER — standalone entry (no lead pre-provided). Reuses the
// existing server-side leads search (GET /api/leads?search=).
// ═══════════════════════════════════════════════════════════════

function LeadPicker({ onPick }: { onPick: (lead: SchedulableLead) => void }) {
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<LeadSearchResult[]>([])
  const term = q.trim()

  // Debounced search. All state writes happen inside the timeout / promise
  // callbacks (never synchronously in the effect body) so a short query simply
  // clears results asynchronously.
  useEffect(() => {
    let active = true
    const t = setTimeout(() => {
      if (!active) return
      if (term.length < 2) { setResults([]); setLoading(false); return }
      setLoading(true)
      fetch(`/api/leads?search=${encodeURIComponent(term)}&per_page=8`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => { if (active) setResults(Array.isArray(d.leads) ? d.leads : []) })
        .catch(() => { if (active) setResults([]) })
        .finally(() => { if (active) setLoading(false) })
    }, 250)
    return () => { active = false; clearTimeout(t) }
  }, [term])

  return (
    <div className="space-y-3 px-5 py-5">
      <div className="flex items-center gap-2 rounded-lg border border-aurea-border bg-aurea-surface px-3 py-2 focus-within:border-aurea-border-strong">
        <Search className="h-4 w-4 shrink-0 text-aurea-ink-3" strokeWidth={1.75} />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search patients by name, phone, or email…"
          className="h-6 flex-1 border-0 bg-transparent p-0 text-[14px] text-aurea-ink outline-none placeholder:text-aurea-ink-3"
        />
        {loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-aurea-ink-3" />}
      </div>
      <div className="max-h-[min(50vh,320px)] space-y-1 overflow-y-auto">
        {term.length < 2 ? (
          <p className="px-1 py-6 text-center text-[13px] text-aurea-ink-3">Type at least 2 characters to search.</p>
        ) : results.length === 0 && !loading ? (
          <p className="px-1 py-6 text-center text-[13px] text-aurea-ink-3">No matching patients.</p>
        ) : (
          results.map((l) => {
            const meta = [l.phone, l.email].filter(Boolean).join(' · ')
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => onPick(l)}
                className="flex w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:border-aurea-border hover:bg-aurea-surface-2"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-aurea-surface-2">
                  <UserRound className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-medium text-aurea-ink">
                    {l.first_name} {l.last_name ?? ''}
                  </span>
                  {meta && <span className="block truncate text-[11px] text-aurea-ink-3">{meta}</span>}
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
