'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Calendar,
  Clock,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  Phone,
  Mail,
} from 'lucide-react'
import { formatTimeDisplay } from '@/lib/booking/availability'

type SlotDay = {
  date: string
  dayOfWeek: number
  dayLabel: string
  times: string[]
}

type BookingData = {
  organization: { name: string; phone: string | null; email: string | null; location: string | null; logo_url: string | null }
  settings: { slot_duration_minutes: number; timezone: string; booking_message: string | null }
  slots: SlotDay[]
}

type BookingStep = 'loading' | 'date' | 'time' | 'details' | 'confirmed'

export function BookingWidget({ orgId }: { orgId: string }) {
  const [step, setStep] = useState<BookingStep>('loading')
  const [data, setData] = useState<BookingData | null>(null)
  const [selectedDate, setSelectedDate] = useState<SlotDay | null>(null)
  const [selectedTime, setSelectedTime] = useState<string | null>(null)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [dob, setDob] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{ scheduled_at: string; message: string } | null>(null)
  const [weekOffset, setWeekOffset] = useState(0)

  useEffect(() => {
    fetch(`/api/booking/${orgId}/slots`)
      .then((r) => {
        if (!r.ok) throw new Error('Not available')
        return r.json()
      })
      .then((d) => {
        setData(d)
        setStep('date')
      })
      .catch(() => {
        setData(null)
        setStep('date') // Will trigger the "not available" UI since data is null
      })
  }, [orgId])

  function handleDateSelect(day: SlotDay) {
    setSelectedDate(day)
    setSelectedTime(null)
    setStep('time')
  }

  function handleTimeSelect(time: string) {
    setSelectedTime(time)
    setStep('details')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedDate || !selectedTime) return
    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch(`/api/booking/${orgId}/book`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slot_date: selectedDate.date,
          slot_time: selectedTime,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          phone: phone.trim(),
          email: email.trim(),
          date_of_birth: dob || undefined,
          notes: notes.trim() || undefined,
        }),
      })

      const result = await res.json()
      if (!res.ok) {
        setError(result.error || 'Booking failed. Please try again.')
        if (res.status === 409) {
          // Slot taken — clear time, refresh slots, go back to time selection
          setSelectedTime(null)
          // Refresh slot data to show updated availability
          fetch(`/api/booking/${orgId}/slots`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              if (d) {
                setData(d)
                // Update the selected date with fresh slot data
                const freshDay = d.slots.find((s: { date: string }) => s.date === selectedDate?.date)
                if (freshDay) setSelectedDate(freshDay)
              }
            })
            .catch((err: unknown) => console.warn('[booking] Slot refresh failed:', err))
          setStep('time')
        }
        return
      }

      setConfirmation({ scheduled_at: result.scheduled_at, message: result.message })
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
        <p className="text-aurea-ink-3 text-[14px]">Loading available times...</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="text-center py-20 animate-in fade-in-0 duration-500">
        <Calendar className="h-12 w-12 text-aurea-ink-3/50 mx-auto mb-4" strokeWidth={1.75} />
        <h2 className="aurea-display text-[22px] text-aurea-ink">Online Booking Not Available</h2>
        <p className="text-aurea-ink-3 mt-2 text-[14px]">Please call us to schedule your appointment.</p>
      </div>
    )
  }

  const { organization, settings, slots } = data

  // Group slots into weeks for navigation
  const visibleDays = slots.slice(weekOffset * 7, (weekOffset + 1) * 7)
  const totalWeeks = Math.ceil(slots.length / 7)

  return (
    <div className="max-w-2xl mx-auto animate-in fade-in-0 duration-500">
      {/* Header */}
      <div className="text-center mb-8">
        {organization.logo_url && (
          // Plain <img>: avoids next/image SVG rasterization and external-host config.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={organization.logo_url}
            alt={`${organization.name} logo`}
            className="h-12 mx-auto mb-3 object-contain"
          />
        )}
        <h1 className="aurea-display text-[32px] text-aurea-ink">{organization.name}</h1>
        <p className="text-aurea-ink-3 mt-2 text-[15px]">
          Book your free {settings.slot_duration_minutes}-minute consultation
        </p>
        {organization.location && (
          <p className="text-[13px] text-aurea-ink-3 mt-1 flex items-center justify-center gap-1">
            <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} /> {organization.location}
          </p>
        )}
      </div>

      {/* Progress Steps */}
      <div className="flex items-center justify-center gap-2 mb-8">
        {['Date', 'Time', 'Details', 'Confirmed'].map((label, i) => {
          const stepIndex = ['date', 'time', 'details', 'confirmed'].indexOf(step)
          const isActive = i <= stepIndex
          return (
            <div key={label} className="flex items-center gap-2">
              <div className={`h-8 w-8 rounded-full flex items-center justify-center text-[12px] font-medium font-mono tabular-nums ${isActive ? 'bg-aurea-primary text-white' : 'bg-aurea-surface-2 text-aurea-ink-3 border border-aurea-border'}`}>
                {i === 3 && step === 'confirmed' ? <CheckCircle className="h-4 w-4" strokeWidth={1.75} /> : i + 1}
              </div>
              <span className={`text-[11px] hidden sm:inline ${isActive ? 'font-medium text-aurea-ink' : 'text-aurea-ink-3'}`}>{label}</span>
              {i < 3 && <div className={`w-8 h-px ${isActive ? 'bg-aurea-primary' : 'bg-aurea-border'}`} />}
            </div>
          )
        })}
      </div>

      {/* Step: Date Selection */}
      {step === 'date' && (
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center justify-between border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[18px] text-aurea-ink flex items-center gap-2">
              <Calendar className="h-[17px] w-[17px] text-aurea-primary" strokeWidth={1.75} />
              Select a Date
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
              <p className="text-center py-8 text-aurea-ink-3 text-[14px]">No available dates. Please check back later.</p>
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

      {/* Step: Time Selection */}
      {step === 'time' && selectedDate && (
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
            <Button variant="ghost" size="sm" onClick={() => setStep('date')}>
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
                  className="h-12 rounded-lg border border-aurea-border bg-aurea-surface text-[13px] font-medium text-aurea-ink transition-colors hover:bg-aurea-primary hover:text-white hover:border-aurea-primary"
                  onClick={() => handleTimeSelect(time)}
                >
                  {formatTimeDisplay(time)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Step: Contact Details */}
      {step === 'details' && selectedDate && selectedTime && (
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
            <Button variant="ghost" size="sm" onClick={() => setStep('time')}>
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
            </Button>
            <h2 className="aurea-display text-[18px] text-aurea-ink">Your Details</h2>
          </div>
          <div className="px-5 py-4">
            <div className="mb-4 p-3 rounded-lg bg-aurea-surface-2 border border-aurea-border text-[14px]">
              <p className="font-medium text-aurea-ink">{selectedDate.dayLabel} at {formatTimeDisplay(selectedTime)}</p>
              <p className="text-aurea-ink-3 text-[13px]">{settings.slot_duration_minutes}-minute consultation</p>
            </div>

            {error && (
              <div className="mb-4 p-3 rounded-lg bg-aurea-rose/10 border border-aurea-rose/30 text-aurea-rose text-[13px]">{error}</div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="first_name">First Name</Label>
                  <Input id="first_name" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
                </div>
                <div>
                  <Label htmlFor="last_name">Last Name</Label>
                  <Input id="last_name" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
                </div>
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 123-4567" required />
              </div>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
              </div>
              <div>
                <Label htmlFor="dob">Date of Birth</Label>
                <Input id="dob" type="date" value={dob} onChange={(e) => setDob(e.target.value)} max={new Date().toISOString().slice(0, 10)} required />
              </div>
              <div>
                <Label htmlFor="notes">Anything you&apos;d like us to know? (optional)</Label>
                <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </div>

              <p className="text-[11.5px] text-aurea-ink-3">
                By booking, you consent to receive appointment confirmations and reminders via SMS and email.
              </p>

              <Button type="submit" className="w-full h-12 text-[15px] bg-aurea-primary text-white hover:bg-aurea-primary/90" disabled={submitting || !firstName || !lastName || !phone || !email || !dob}>
                {submitting ? <Loader2 className="h-5 w-5 animate-spin mr-2" strokeWidth={1.75} /> : <CheckCircle className="h-5 w-5 mr-2" strokeWidth={1.75} />}
                {submitting ? 'Booking...' : 'Confirm Booking'}
              </Button>
            </form>
          </div>
        </div>
      )}

      {/* Step: Confirmation */}
      {step === 'confirmed' && confirmation && selectedDate && selectedTime && (
        <div className="aurea-card overflow-hidden">
          <div className="px-5 pt-8 pb-8 text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-aurea-primary/10 flex items-center justify-center mb-4 ring-1 ring-aurea-primary/20">
              <CheckCircle className="h-8 w-8 text-aurea-primary" strokeWidth={1.75} />
            </div>
            <h2 className="aurea-display text-[28px] text-aurea-ink mb-2">You&apos;re All Set!</h2>
            <p className="text-aurea-ink-3 mb-6 text-[14px]">{confirmation.message}</p>

            <div className="bg-aurea-surface-2 border border-aurea-border rounded-lg p-4 inline-block text-left mx-auto">
              <p className="font-medium text-[15px] text-aurea-ink">{selectedDate.dayLabel}</p>
              <p className="text-aurea-ink-3 text-[13px] font-mono tabular-nums">
                {formatTimeDisplay(selectedTime)} &middot; {settings.slot_duration_minutes} minutes
              </p>
              {organization.location && (
                <p className="text-[12px] text-aurea-ink-3 mt-2 flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} /> {organization.location}
                </p>
              )}
            </div>

            <div className="mt-6 space-y-2 text-[13px] text-aurea-ink-3">
              <p>A confirmation has been sent to your phone and email.</p>
              {organization.phone && (
                <p className="flex items-center justify-center gap-1">
                  <Phone className="h-3.5 w-3.5" strokeWidth={1.75} /> Need to reschedule? Call {organization.phone}
                </p>
              )}
              {organization.email && (
                <p className="flex items-center justify-center gap-1">
                  <Mail className="h-3.5 w-3.5" strokeWidth={1.75} /> Or email {organization.email}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
