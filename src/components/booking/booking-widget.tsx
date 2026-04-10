'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
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
  organization: { name: string; phone: string | null; email: string | null; location: string | null }
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
      .catch(() => setStep('loading'))
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
            .catch(() => {})
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

  if (step === 'loading' && !data) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
        <p className="text-muted-foreground">Loading available times...</p>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="text-center py-20">
        <Calendar className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
        <h2 className="text-xl font-semibold">Online Booking Not Available</h2>
        <p className="text-muted-foreground mt-2">Please call us to schedule your appointment.</p>
      </div>
    )
  }

  const { organization, settings, slots } = data

  // Group slots into weeks for navigation
  const visibleDays = slots.slice(weekOffset * 7, (weekOffset + 1) * 7)
  const totalWeeks = Math.ceil(slots.length / 7)

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold">{organization.name}</h1>
        <p className="text-muted-foreground mt-2">
          Book your free {settings.slot_duration_minutes}-minute consultation
        </p>
        {organization.location && (
          <p className="text-sm text-muted-foreground mt-1 flex items-center justify-center gap-1">
            <MapPin className="h-3.5 w-3.5" /> {organization.location}
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
              <div className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-medium ${isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                {i === 3 && step === 'confirmed' ? <CheckCircle className="h-4 w-4" /> : i + 1}
              </div>
              <span className={`text-xs hidden sm:inline ${isActive ? 'font-medium' : 'text-muted-foreground'}`}>{label}</span>
              {i < 3 && <div className={`w-8 h-0.5 ${isActive ? 'bg-primary' : 'bg-muted'}`} />}
            </div>
          )
        })}
      </div>

      {/* Step: Date Selection */}
      {step === 'date' && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Calendar className="h-5 w-5 text-primary" />
                Select a Date
              </h2>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" disabled={weekOffset === 0} onClick={() => setWeekOffset(weekOffset - 1)}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" disabled={weekOffset >= totalWeeks - 1} onClick={() => setWeekOffset(weekOffset + 1)}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {visibleDays.length === 0 ? (
              <p className="text-center py-8 text-muted-foreground">No available dates. Please check back later.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {visibleDays.map((day) => (
                  <Button
                    key={day.date}
                    variant="outline"
                    className="h-auto py-3 px-4 justify-between"
                    onClick={() => handleDateSelect(day)}
                  >
                    <span className="font-medium">{day.dayLabel}</span>
                    <Badge variant="secondary" className="text-xs">{day.times.length} slots</Badge>
                  </Button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step: Time Selection */}
      {step === 'time' && selectedDate && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 mb-4">
              <Button variant="ghost" size="sm" onClick={() => setStep('date')}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <Clock className="h-5 w-5 text-primary" />
                {selectedDate.dayLabel}
              </h2>
            </div>

            {error && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>
            )}

            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {selectedDate.times.map((time) => (
                <Button
                  key={time}
                  variant="outline"
                  className="h-12"
                  onClick={() => handleTimeSelect(time)}
                >
                  {formatTimeDisplay(time)}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step: Contact Details */}
      {step === 'details' && selectedDate && selectedTime && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 mb-4">
              <Button variant="ghost" size="sm" onClick={() => setStep('time')}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <h2 className="text-lg font-semibold">Your Details</h2>
            </div>

            <div className="mb-4 p-3 rounded-lg bg-primary/5 text-sm">
              <p className="font-medium">{selectedDate.dayLabel} at {formatTimeDisplay(selectedTime)}</p>
              <p className="text-muted-foreground">{settings.slot_duration_minutes}-minute consultation</p>
            </div>

            {error && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 text-red-700 text-sm">{error}</div>
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
                <Label htmlFor="notes">Anything you'd like us to know? (optional)</Label>
                <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
              </div>

              <p className="text-xs text-muted-foreground">
                By booking, you consent to receive appointment confirmations and reminders via SMS and email.
              </p>

              <Button type="submit" className="w-full h-12 text-base" disabled={submitting || !firstName || !lastName || !phone || !email}>
                {submitting ? <Loader2 className="h-5 w-5 animate-spin mr-2" /> : <CheckCircle className="h-5 w-5 mr-2" />}
                {submitting ? 'Booking...' : 'Confirm Booking'}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* Step: Confirmation */}
      {step === 'confirmed' && confirmation && selectedDate && selectedTime && (
        <Card>
          <CardContent className="pt-8 pb-8 text-center">
            <div className="mx-auto w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mb-4">
              <CheckCircle className="h-8 w-8 text-green-600" />
            </div>
            <h2 className="text-2xl font-bold mb-2">You're All Set!</h2>
            <p className="text-muted-foreground mb-6">{confirmation.message}</p>

            <div className="bg-muted rounded-lg p-4 inline-block text-left mx-auto">
              <p className="font-medium text-lg">{selectedDate.dayLabel}</p>
              <p className="text-muted-foreground">{formatTimeDisplay(selectedTime)} &middot; {settings.slot_duration_minutes} minutes</p>
              {organization.location && (
                <p className="text-sm text-muted-foreground mt-2 flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" /> {organization.location}
                </p>
              )}
            </div>

            <div className="mt-6 space-y-2 text-sm text-muted-foreground">
              <p>A confirmation has been sent to your phone and email.</p>
              {organization.phone && (
                <p className="flex items-center justify-center gap-1">
                  <Phone className="h-3.5 w-3.5" /> Need to reschedule? Call {organization.phone}
                </p>
              )}
              {organization.email && (
                <p className="flex items-center justify-center gap-1">
                  <Mail className="h-3.5 w-3.5" /> Or email {organization.email}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
