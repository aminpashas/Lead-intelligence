'use client'

// ═══════════════════════════════════════════════════════════════
// APPOINTMENTS CALENDAR
// ───────────────────────────────────────────────────────────────
// Month + Week visualisation of booked appointments. Pure read-model:
// it renders whatever the /appointments page already fetched from
// GET /api/appointments — no data fetching of its own. Times are shown
// in the viewer's local timezone (same convention as the list view).
// ═══════════════════════════════════════════════════════════════

import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// Minimal shape this component needs — a structural subset of the page's
// AppointmentData, so the page can pass its rows straight through.
export type CalendarAppointment = {
  id: string
  type: string
  status: string
  scheduled_at: string
  duration_minutes: number
  location: string | null
  confirmation_received: boolean
  no_show_risk_score: number
  lead: {
    id: string
    first_name: string
    last_name: string | null
  } | null
}

type ViewMode = 'month' | 'week'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// Week grid runs 7:00 → 20:00 (inclusive start, exclusive end row at 20:00).
const WEEK_START_HOUR = 7
const WEEK_END_HOUR = 20
const HOUR_ROW_PX = 52

export function AppointmentsCalendar({
  appointments,
  defaultView = 'month',
  onSelect,
}: {
  appointments: CalendarAppointment[]
  defaultView?: ViewMode
  onSelect?: (appt: CalendarAppointment) => void
}) {
  const [view, setView] = useState<ViewMode>(defaultView)
  // `anchor` is any date inside the visible month/week. Nav shifts it.
  const [anchor, setAnchor] = useState<Date>(() => new Date())

  // Bucket appointments by local YYYY-MM-DD for O(1) day lookups.
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarAppointment[]>()
    for (const a of appointments) {
      if (a.status === 'canceled') continue
      const key = dayKey(new Date(a.scheduled_at))
      const list = map.get(key)
      if (list) list.push(a)
      else map.set(key, [a])
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())
    }
    return map
  }, [appointments])

  const goToday = () => setAnchor(new Date())
  const shift = (dir: -1 | 1) => {
    setAnchor((prev) => {
      const d = new Date(prev)
      if (view === 'month') d.setMonth(d.getMonth() + dir)
      else d.setTime(d.getTime() + dir * 7 * DAY_MS)
      return d
    })
  }

  const headingLabel =
    view === 'month'
      ? anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : weekRangeLabel(anchor)

  return (
    <div className="aurea-card p-0 overflow-hidden">
      {/* ── Toolbar ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 border-b border-aurea-border">
        <div className="flex items-center gap-2">
          <button
            onClick={() => shift(-1)}
            className="h-8 w-8 flex items-center justify-center rounded-md border border-aurea-border hover:bg-aurea-surface-2 transition-colors"
            aria-label="Previous"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => shift(1)}
            className="h-8 w-8 flex items-center justify-center rounded-md border border-aurea-border hover:bg-aurea-surface-2 transition-colors"
            aria-label="Next"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            onClick={goToday}
            className="h-8 px-3 text-xs font-medium rounded-md border border-aurea-border hover:bg-aurea-surface-2 transition-colors"
          >
            Today
          </button>
          <h2 className="ml-2 text-[17px] font-semibold text-aurea-ink tabular-nums">{headingLabel}</h2>
        </div>

        <div className="flex items-center gap-1 bg-aurea-surface-2 rounded-lg p-0.5 self-start sm:self-auto">
          {(['month', 'week'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setView(m)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
                view === m ? 'bg-aurea-primary text-primary-foreground shadow-sm' : 'text-aurea-ink-2 hover:text-aurea-ink'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {view === 'month' ? (
        <MonthView anchor={anchor} byDay={byDay} onSelect={onSelect} />
      ) : (
        <WeekView anchor={anchor} byDay={byDay} onSelect={onSelect} />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// MONTH VIEW — 6-week day grid with appointment chips
// ═══════════════════════════════════════════════════════════════

function MonthView({
  anchor,
  byDay,
  onSelect,
}: {
  anchor: Date
  byDay: Map<string, CalendarAppointment[]>
  onSelect?: (a: CalendarAppointment) => void
}) {
  const cells = useMemo(() => monthGridDays(anchor), [anchor])
  const todayKey = dayKey(new Date())
  const currentMonth = anchor.getMonth()

  return (
    <div>
      {/* Weekday header */}
      <div className="grid grid-cols-7 border-b border-aurea-border">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-aurea-ink-3 text-center">
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7">
        {cells.map((day) => {
          const key = dayKey(day)
          const appts = byDay.get(key) || []
          const isCurrentMonth = day.getMonth() === currentMonth
          const isToday = key === todayKey
          const shown = appts.slice(0, 3)
          const overflow = appts.length - shown.length

          return (
            <div
              key={key}
              className={`min-h-[104px] border-b border-r border-aurea-border p-1.5 flex flex-col gap-1 ${
                isCurrentMonth ? 'bg-transparent' : 'bg-aurea-surface-2/40'
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-[12px] tabular-nums flex items-center justify-center h-6 w-6 rounded-full ${
                    isToday
                      ? 'bg-aurea-primary text-primary-foreground font-semibold'
                      : isCurrentMonth
                      ? 'text-aurea-ink'
                      : 'text-aurea-ink-3'
                  }`}
                >
                  {day.getDate()}
                </span>
                {appts.length > 0 && (
                  <span className="text-[10px] text-aurea-ink-3 tabular-nums">{appts.length}</span>
                )}
              </div>

              <div className="flex flex-col gap-0.5">
                {shown.map((a) => (
                  <MonthChip key={a.id} appt={a} onSelect={onSelect} />
                ))}
                {overflow > 0 && (
                  <span className="text-[10px] text-aurea-ink-3 pl-1">+{overflow} more</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function MonthChip({ appt, onSelect }: { appt: CalendarAppointment; onSelect?: (a: CalendarAppointment) => void }) {
  const c = statusColors(appt)
  return (
    <button
      onClick={() => onSelect?.(appt)}
      title={`${formatTime(appt.scheduled_at)} — ${leadName(appt)} (${appt.type.replace('_', ' ')})`}
      className={`group flex items-center gap-1 rounded px-1 py-0.5 text-left ${c.chipBg} ${c.chipText} hover:brightness-95 transition`}
    >
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${c.dot}`} />
      <span className="text-[10px] tabular-nums shrink-0 font-medium">{formatTimeCompact(appt.scheduled_at)}</span>
      <span className="text-[10px] truncate">{leadName(appt)}</span>
    </button>
  )
}

// ═══════════════════════════════════════════════════════════════
// WEEK VIEW — time-of-day grid, blocks positioned by start + duration
// ═══════════════════════════════════════════════════════════════

function WeekView({
  anchor,
  byDay,
  onSelect,
}: {
  anchor: Date
  byDay: Map<string, CalendarAppointment[]>
  onSelect?: (a: CalendarAppointment) => void
}) {
  const days = useMemo(() => weekDays(anchor), [anchor])
  const hours = useMemo(() => {
    const out: number[] = []
    for (let h = WEEK_START_HOUR; h < WEEK_END_HOUR; h++) out.push(h)
    return out
  }, [])
  const todayKey = dayKey(new Date())
  const gridHeight = (WEEK_END_HOUR - WEEK_START_HOUR) * HOUR_ROW_PX

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px]">
        {/* Day header row */}
        <div className="grid border-b border-aurea-border" style={{ gridTemplateColumns: `56px repeat(7, 1fr)` }}>
          <div />
          {days.map((d) => {
            const key = dayKey(d)
            const isToday = key === todayKey
            const count = (byDay.get(key) || []).length
            return (
              <div key={key} className="px-2 py-2 text-center border-l border-aurea-border">
                <div className="text-[11px] uppercase tracking-wide text-aurea-ink-3">{WEEKDAY_LABELS[d.getDay()]}</div>
                <div
                  className={`mx-auto mt-0.5 flex items-center justify-center h-7 w-7 rounded-full text-[13px] tabular-nums ${
                    isToday ? 'bg-aurea-primary text-primary-foreground font-semibold' : 'text-aurea-ink'
                  }`}
                >
                  {d.getDate()}
                </div>
                {count > 0 && <div className="text-[10px] text-aurea-ink-3 mt-0.5 tabular-nums">{count} appt{count > 1 ? 's' : ''}</div>}
              </div>
            )
          })}
        </div>

        {/* Time grid */}
        <div className="grid" style={{ gridTemplateColumns: `56px repeat(7, 1fr)` }}>
          {/* Hour labels */}
          <div className="relative" style={{ height: gridHeight }}>
            {hours.map((h, i) => (
              <div
                key={h}
                className="absolute right-1 -translate-y-1/2 text-[10px] text-aurea-ink-3 tabular-nums"
                style={{ top: i * HOUR_ROW_PX }}
              >
                {formatHour(h)}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {days.map((d) => {
            const key = dayKey(d)
            const appts = byDay.get(key) || []
            return (
              <div key={key} className="relative border-l border-aurea-border" style={{ height: gridHeight }}>
                {/* Hour lines */}
                {hours.map((h, i) => (
                  <div
                    key={h}
                    className="absolute left-0 right-0 border-t border-aurea-border/60"
                    style={{ top: i * HOUR_ROW_PX }}
                  />
                ))}
                {/* Appointment blocks */}
                {appts.map((a) => {
                  const pos = weekBlockPosition(a)
                  if (!pos) return null
                  const c = statusColors(a)
                  return (
                    <button
                      key={a.id}
                      onClick={() => onSelect?.(a)}
                      title={`${formatTime(a.scheduled_at)} — ${leadName(a)} (${a.type.replace('_', ' ')})`}
                      className={`absolute left-0.5 right-0.5 rounded-md px-1.5 py-1 text-left overflow-hidden border ${c.blockBg} ${c.blockBorder} hover:brightness-95 transition`}
                      style={{ top: pos.top, height: pos.height }}
                    >
                      <div className={`text-[10px] font-semibold tabular-nums ${c.chipText}`}>{formatTimeCompact(a.scheduled_at)}</div>
                      <div className={`text-[11px] font-medium truncate ${c.chipText}`}>{leadName(a)}</div>
                      {pos.height > 40 && (
                        <div className="text-[10px] text-aurea-ink-3 truncate capitalize">{a.type.replace('_', ' ')}</div>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** All 42 days (6 weeks) of the month grid containing `anchor`, Sun-aligned. */
function monthGridDays(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const gridStart = new Date(first)
  gridStart.setDate(1 - first.getDay()) // back up to the preceding Sunday
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    return d
  })
}

/** The 7 days (Sun→Sat) of the week containing `anchor`. */
function weekDays(anchor: Date): Date[] {
  const start = new Date(anchor)
  start.setDate(anchor.getDate() - anchor.getDay())
  start.setHours(0, 0, 0, 0)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return d
  })
}

function weekRangeLabel(anchor: Date): string {
  const days = weekDays(anchor)
  const start = days[0]
  const end = days[6]
  const sameMonth = start.getMonth() === end.getMonth()
  const startStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const endStr = end.toLocaleDateString('en-US', sameMonth ? { day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
  return `${startStr} – ${endStr}`
}

/** Pixel top/height for an appointment block within the week grid, or null if outside the visible hours. */
function weekBlockPosition(a: CalendarAppointment): { top: number; height: number } | null {
  const start = new Date(a.scheduled_at)
  const startHours = start.getHours() + start.getMinutes() / 60
  if (startHours >= WEEK_END_HOUR) return null
  const clampedStart = Math.max(startHours, WEEK_START_HOUR)
  const endHours = Math.min(startHours + (a.duration_minutes || 60) / 60, WEEK_END_HOUR)
  if (endHours <= WEEK_START_HOUR) return null
  const top = (clampedStart - WEEK_START_HOUR) * HOUR_ROW_PX
  const height = Math.max((endHours - clampedStart) * HOUR_ROW_PX, 22)
  return { top, height }
}

function leadName(a: CalendarAppointment): string {
  if (!a.lead) return 'Unknown'
  return `${a.lead.first_name}${a.lead.last_name ? ' ' + a.lead.last_name : ''}`.trim() || 'Unknown'
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

/** Compact time e.g. "3p" / "3:30p" for dense chips. */
function formatTimeCompact(iso: string): string {
  const d = new Date(iso)
  const h = d.getHours()
  const m = d.getMinutes()
  const suffix = h >= 12 ? 'p' : 'a'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, '0')}${suffix}`
}

function formatHour(h: number): string {
  const suffix = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12} ${suffix}`
}

/** Status-driven colour set, reusing the Aurea token palette. */
function statusColors(a: CalendarAppointment): {
  dot: string
  chipBg: string
  chipText: string
  blockBg: string
  blockBorder: string
} {
  // High no-show risk overrides colour regardless of status.
  if (a.no_show_risk_score >= 50 && a.status !== 'completed' && a.status !== 'canceled') {
    return {
      dot: 'bg-aurea-rose',
      chipBg: 'bg-aurea-rose/10',
      chipText: 'text-aurea-rose',
      blockBg: 'bg-aurea-rose/10',
      blockBorder: 'border-aurea-rose/30',
    }
  }
  switch (a.status) {
    case 'pending_card':
      // Held slot awaiting a card on file — not a confirmed booking. Muted +
      // dashed so it reads as provisional.
      return { dot: 'bg-aurea-ink-3', chipBg: 'bg-aurea-surface-2', chipText: 'text-aurea-ink-3', blockBg: 'bg-aurea-surface-2/60', blockBorder: 'border-dashed border-aurea-border-strong' }
    case 'confirmed':
      return { dot: 'bg-aurea-primary', chipBg: 'bg-aurea-primary/10', chipText: 'text-aurea-primary', blockBg: 'bg-aurea-primary/10', blockBorder: 'border-aurea-primary/30' }
    case 'completed':
      return { dot: 'bg-aurea-ink-3', chipBg: 'bg-aurea-surface-2', chipText: 'text-aurea-ink-2', blockBg: 'bg-aurea-surface-2', blockBorder: 'border-aurea-border' }
    case 'no_show':
      return { dot: 'bg-aurea-rose', chipBg: 'bg-aurea-rose/10', chipText: 'text-aurea-rose', blockBg: 'bg-aurea-rose/10', blockBorder: 'border-aurea-rose/30' }
    case 'rescheduled':
      return { dot: 'bg-aurea-amber', chipBg: 'bg-aurea-amber/10', chipText: 'text-aurea-amber', blockBg: 'bg-aurea-amber/10', blockBorder: 'border-aurea-amber/30' }
    default: // scheduled
      return { dot: 'bg-aurea-amber', chipBg: 'bg-aurea-amber/10', chipText: 'text-aurea-ink-2', blockBg: 'bg-aurea-amber/5', blockBorder: 'border-aurea-amber/25' }
  }
}
