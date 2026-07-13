'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import {
  Calendar,
  Clock,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  Phone,
} from 'lucide-react'
import { formatTimeDisplay } from '@/lib/booking/availability'

type SlotDay = {
  date: string
  dayOfWeek: number
  dayLabel: string
  times: string[]
}

type RescheduleData = {
  organization: { name: string; phone: string | null; location: string | null; logo_url: string | null }
  settings: { slot_duration_minutes: number; timezone: string; booking_message: string | null }
  current: { scheduled_at: string }
  slots: SlotDay[]
}

type Step = 'loading' | 'unavailable' | 'date' | 'time' | 'confirmed'

export function RescheduleWidget({ token }: { token: string }) {
  const [step, setStep] = useState<Step>('loading')
  const [data, setData] = useState<RescheduleData | null>(null)
  const [loadError, setLoadError] = useState<'expired' | 'not_found' | 'generic' | null>(null)
  const [selectedDate, setSelectedDate] = useState<SlotDay | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null)
  const [weekOffset, setWeekOffset] = useState(0)

  useEffect(() => {
    if (!token) {
      setLoadError('generic')
      setStep('unavailable')
      return
    }
    fetch(`/api/appointments/reschedule?token=${encodeURIComponent(token)}`)
      .then(async (r) => {
        if (r.ok) return r.json()
        const body = await r.json().catch(() => ({}))
        throw new Error(body.error || 'generic')
      })
      .then((d: RescheduleData) => {
        setData(d)
        setStep('date')
      })
      .catch((err: Error) => {
        setLoadError(err.message === 'expired' || err.message === 'invalid' ? 'expired' : err.message === 'not_found' || err.message === 'not_reschedulable' ? 'not_found' : 'generic')
        setStep('unavailable')
      })
  }, [token])

  function handleDateSelect(day: SlotDay) {
    setSelectedDate(day)
    setError(null)
    setStep('time')
  }

  async function handleTimeSelect(time: string) {
    if (!selectedDate || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/appointments/reschedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, slot_date: selectedDate.date, slot_time: time }),
      })
      const result = await res.json()
      if (!res.ok) {
        setError(result.error || 'Something went wrong. Please try again.')
        if (res.status === 409) {
          // Slot taken — refresh availability and stay on time selection.
          const refreshed = await fetch(`/api/appointments/reschedule?token=${encodeURIComponent(token)}`)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
          if (refreshed) {
            setData(refreshed)
            const freshDay = (refreshed.slots as SlotDay[]).find((s) => s.date === selectedDate.date)
            setSelectedDate(freshDay ?? null)
            if (!freshDay) setStep('date')
          }
        }
        return
      }
      setConfirmedAt(result.scheduled_at)
      setStep('confirmed')
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (step === 'loading') {
    return (
      <div className="flex flex-col items-center justify-center py-20 animate-in fade-in-0 duration-500">
        <Loader2 className="h-8 w-8 animate-spin text-aurea-primary mb-4" strokeWidth={1.75} />
        <p className="text-aurea-ink-3 text-[14px]">Loading available times…</p>
      </div>
    )
  }

  if (step === 'unavailable') {
    const phone = data?.organization.phone
    const heading =
      loadError === 'expired'
        ? 'This Link Has Expired'
        : loadError === 'not_found'
          ? 'Appointment Not Found'
          : 'Unable to Reschedule Online'
    const body =
      loadError === 'expired'
        ? 'For your security, reschedule links expire after two weeks.'
        : loadError === 'not_found'
          ? 'We couldn’t find an upcoming appointment for this link.'
          : 'Please give us a call and we’ll find a new time that works for you.'
    return (
      <div className="text-center py-20 animate-in fade-in-0 duration-500">
        <Calendar className="h-12 w-12 text-aurea-ink-3/50 mx-auto mb-4" strokeWidth={1.75} />
        <h2 className="aurea-display text-[22px] text-aurea-ink">{heading}</h2>
        <p className="text-aurea-ink-3 mt-2 text-[14px] max-w-sm mx-auto">{body}</p>
        {phone && (
          <a
            href={`tel:${phone}`}
            className="mt-5 inline-flex items-center gap-2 rounded-lg border border-aurea-border bg-aurea-surface px-4 py-2.5 text-[14px] font-medium text-aurea-ink hover:bg-aurea-surface-2"
          >
            <Phone className="h-4 w-4 text-aurea-primary" strokeWidth={1.75} /> {phone}
          </a>
        )}
      </div>
    )
  }

  if (!data) return null
  const { organization, settings, current, slots } = data

  const currentDisplay = new Date(current.scheduled_at).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: settings.timezone,
  })

  const visibleDays = slots.slice(weekOffset * 7, (weekOffset + 1) * 7)
  const totalWeeks = Math.max(1, Math.ceil(slots.length / 7))

  return (
    <div className="max-w-2xl mx-auto animate-in fade-in-0 duration-500">
      {/* Header */}
      <div className="text-center mb-8">
        {organization.logo_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={organization.logo_url} alt={`${organization.name} logo`} className="h-12 mx-auto mb-3 object-contain" />
        )}
        <h1 className="aurea-display text-[32px] text-aurea-ink">{organization.name}</h1>
        <p className="text-aurea-ink-3 mt-2 text-[15px]">Reschedule your consultation</p>
        {organization.location && (
          <p className="text-[13px] text-aurea-ink-3 mt-1 flex items-center justify-center gap-1">
            <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} /> {organization.location}
          </p>
        )}
      </div>

      {/* Current appointment context (hidden once confirmed) */}
      {step !== 'confirmed' && (
        <div className="mb-6 rounded-lg border border-aurea-border bg-aurea-surface-2 px-4 py-3 text-center">
          <p className="text-[12px] uppercase tracking-wide text-aurea-ink-3">Currently booked for</p>
          <p className="text-[15px] font-medium text-aurea-ink mt-0.5">{currentDisplay}</p>
        </div>
      )}

      {/* Step: Date */}
      {step === 'date' && (
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[18px] text-aurea-ink flex items-center gap-2">
              <Calendar className="h-[17px] w-[17px] text-aurea-primary" strokeWidth={1.75} />
              Pick a New Date
            </h2>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" disabled={weekOffset === 0} onClick={() => setWeekOffset(weekOffset - 1)}>
                <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
              </Button>
              <Button variant="ghost" size="sm" disabled={weekOffset >= totalWeeks - 1} onClick={() => setWeekOffset(weekOffset + 1)}>
                <ChevronRight className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </div>
          </div>
          <div className="px-5 py-4">
            {visibleDays.length === 0 ? (
              <p className="text-center py-8 text-aurea-ink-3 text-[14px]">No available dates right now. Please call us to reschedule.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {visibleDays.map((day) => (
                  <button
                    key={day.date}
                    className="flex items-center justify-between rounded-lg border border-aurea-border bg-aurea-surface px-4 py-3 text-left transition-colors hover:bg-aurea-surface-2 hover:border-aurea-border-strong"
                    onClick={() => handleDateSelect(day)}
                  >
                    <span className="font-medium text-[14px] text-aurea-ink">{day.dayLabel}</span>
                    <span className="font-mono tabular-nums text-[11px] text-aurea-ink-3 bg-aurea-surface-2 border border-aurea-border rounded-md px-2 py-0.5">
                      {day.times.length} slots
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Step: Time */}
      {step === 'time' && selectedDate && (
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
            <Button variant="ghost" size="sm" onClick={() => setStep('date')} disabled={submitting}>
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
            </Button>
            <h2 className="aurea-display text-[18px] text-aurea-ink flex items-center gap-2">
              <Clock className="h-[17px] w-[17px] text-aurea-primary" strokeWidth={1.75} />
              {selectedDate.dayLabel}
            </h2>
          </div>
          <div className="px-5 py-4">
            {error && (
              <div className="mb-4 p-3 rounded-lg bg-aurea-rose/10 border border-aurea-rose/30 text-aurea-rose text-[13px]">{error}</div>
            )}
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {selectedDate.times.map((time) => (
                <button
                  key={time}
                  disabled={submitting}
                  className="h-12 rounded-lg border border-aurea-border bg-aurea-surface text-[13px] font-medium text-aurea-ink transition-colors hover:bg-aurea-primary hover:text-white hover:border-aurea-primary disabled:opacity-50"
                  onClick={() => handleTimeSelect(time)}
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin mx-auto" strokeWidth={1.75} /> : formatTimeDisplay(time)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Step: Confirmed */}
      {step === 'confirmed' && confirmedAt && (
        <div className="aurea-card overflow-hidden">
          <div className="px-5 pt-8 pb-8 text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-aurea-primary/10 flex items-center justify-center mb-4 ring-1 ring-aurea-primary/20">
              <CheckCircle className="h-8 w-8 text-aurea-primary" strokeWidth={1.75} />
            </div>
            <h2 className="aurea-display text-[28px] text-aurea-ink mb-2">You&apos;re Rescheduled!</h2>
            <p className="text-aurea-ink-3 mb-6 text-[14px]">
              Your new appointment is confirmed for{' '}
              <span className="font-medium text-aurea-ink">
                {new Date(confirmedAt).toLocaleString('en-US', {
                  weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
                  timeZone: settings.timezone,
                })}
              </span>
              . We&apos;ve sent you a confirmation — you can close this page now.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
