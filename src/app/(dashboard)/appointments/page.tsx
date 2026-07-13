'use client'

import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Calendar,
  CheckCircle2,
  Clock,
  AlertTriangle,
  Phone,
  Mail,
  MessageSquare,
  RefreshCw,
  Send,
  XCircle,
  User,
  MapPin,
  TrendingDown,
  TrendingUp,
  BarChart3,
  PhoneCall,
  ChevronRight,
  Filter,
  Loader2,
  CalendarDays,
  type LucideIcon,
} from 'lucide-react'
import { AppointmentsCalendar } from '@/components/crm/appointments-calendar'

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

type AppointmentLead = {
  id: string
  first_name: string
  last_name: string | null
  phone: string | null
  email: string | null
}

type AppointmentData = {
  id: string
  organization_id: string
  lead_id: string
  type: string
  status: string
  scheduled_at: string
  duration_minutes: number
  location: string | null
  notes: string | null
  reminder_sent_72h: boolean
  reminder_sent_24h: boolean
  reminder_sent_2h: boolean
  reminder_sent_1h: boolean
  confirmation_call_made: boolean
  confirmation_received: boolean
  confirmed_via: string | null
  confirmed_at: string | null
  reschedule_requested: boolean
  no_show_risk_score: number
  lead: AppointmentLead
}

type ReminderData = {
  id: string
  appointment_id: string
  channel: string
  reminder_type: string
  status: string
  confirmation_status: string
  sent_at: string | null
  response_at: string | null
  response_text: string | null
  error_message: string | null
  created_at: string
}

type TabKey = 'calendar' | 'upcoming' | 'today' | 'reminders' | 'analytics'

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════

export default function AppointmentsPage() {
  const [appointments, setAppointments] = useState<AppointmentData[]>([])
  const [reminders, setReminders] = useState<ReminderData[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<TabKey>('upcoming')
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const fetchAppointments = useCallback(async () => {
    try {
      const res = await fetch('/api/appointments')
      const data = await res.json()
      setAppointments(data.appointments || [])
    } catch (err) {
      console.error('Failed to fetch appointments:', err)
    }
  }, [])

  const fetchReminders = useCallback(async () => {
    try {
      const res = await fetch('/api/appointments/reminders')
      const data = await res.json()
      setReminders(data.reminders || [])
    } catch (err) {
      console.error('Failed to fetch reminders:', err)
    }
  }, [])

  useEffect(() => {
    Promise.all([fetchAppointments(), fetchReminders()]).finally(() => setLoading(false))
  }, [fetchAppointments, fetchReminders])

  // ── KPI card → drill-down into the matching tab + filter ──
  const selectKpi = (tab: TabKey, filter: string) => {
    setActiveTab(tab)
    setStatusFilter(filter)
  }

  // ── Actions ──
  const handleConfirm = async (id: string) => {
    setActionLoading(id)
    try {
      await fetch('/api/appointments/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointment_id: id, method: 'manual' }),
      })
      await fetchAppointments()
    } finally {
      setActionLoading(null)
    }
  }

  const handleStatusChange = async (id: string, status: string) => {
    setActionLoading(id)
    try {
      await fetch('/api/appointments', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointment_id: id, status }),
      })
      await fetchAppointments()
    } finally {
      setActionLoading(null)
    }
  }

  const handleSendReminder = async (id: string) => {
    setActionLoading(`reminder-${id}`)
    try {
      await fetch('/api/appointments/reminders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointment_id: id }),
      })
      await Promise.all([fetchAppointments(), fetchReminders()])
    } finally {
      setActionLoading(null)
    }
  }

  // ── Computed Data ──
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000)

  const upcomingApts = appointments.filter(a => new Date(a.scheduled_at) > now && ['scheduled', 'confirmed'].includes(a.status))
  const todayApts = appointments.filter(a => {
    const d = new Date(a.scheduled_at)
    return d >= todayStart && d < todayEnd && ['scheduled', 'confirmed', 'completed', 'no_show'].includes(a.status)
  })

  const confirmedCount = appointments.filter(a => a.confirmation_received && new Date(a.scheduled_at) > now).length
  const pendingCount = upcomingApts.filter(a => !a.confirmation_received).length
  const atRiskCount = upcomingApts.filter(a => a.no_show_risk_score >= 50).length
  const confirmedRate = upcomingApts.length > 0 ? Math.round((confirmedCount / upcomingApts.length) * 100) : 0

  // No-show analytics
  const last30d = appointments.filter(a => {
    const d = new Date(a.scheduled_at)
    return d < now && d > new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  })
  const noShowRate = last30d.length > 0
    ? Math.round((last30d.filter(a => a.status === 'no_show').length / last30d.length) * 100)
    : 0

  // Filter for display
  const displayApts = (activeTab === 'today' ? todayApts : upcomingApts).filter(a => {
    if (statusFilter === 'all') return true
    if (statusFilter === 'confirmed') return a.confirmation_received
    if (statusFilter === 'pending') return !a.confirmation_received
    if (statusFilter === 'at_risk') return a.no_show_risk_score >= 50
    return a.status === statusFilter
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="space-y-6 animate-in fade-in-0 duration-500">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="aurea-eyebrow mb-1">Scheduling</p>
          <h1 className="aurea-display text-[40px] text-aurea-ink">Appointments &amp; Reminders</h1>
          <p className="text-aurea-ink-2 text-[16px]">
            Multi-channel reminders, confirmation tracking, and no-show prevention
          </p>
        </div>
        <Button onClick={() => { fetchAppointments(); fetchReminders() }} variant="outline" size="sm">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* ── KPI Cards (click to drill into the matching leads) ── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiCard
          active={activeTab === 'today'}
          onClick={() => selectKpi('today', 'all')}
        >
          <Calendar className="text-aurea-ink-3 h-[17px] w-[17px]" strokeWidth={1.75} />
          <div>
            <p className="aurea-display text-[32px] tabular-nums text-aurea-ink">{todayApts.length}</p>
            <p className="aurea-eyebrow">Today</p>
          </div>
        </KpiCard>

        <KpiCard
          active={activeTab === 'upcoming' && statusFilter === 'confirmed'}
          onClick={() => selectKpi('upcoming', 'confirmed')}
        >
          <CheckCircle2 className="text-aurea-primary h-[17px] w-[17px]" strokeWidth={1.75} />
          <div>
            <p className="aurea-display text-[32px] tabular-nums text-aurea-ink">{confirmedRate}%</p>
            <p className="aurea-eyebrow">Confirmed</p>
          </div>
        </KpiCard>

        <KpiCard
          active={activeTab === 'upcoming' && statusFilter === 'pending'}
          onClick={() => selectKpi('upcoming', 'pending')}
        >
          <Clock className="text-aurea-amber h-[17px] w-[17px]" strokeWidth={1.75} />
          <div>
            <p className="aurea-display text-[32px] tabular-nums text-aurea-ink">{pendingCount}</p>
            <p className="aurea-eyebrow">Pending</p>
          </div>
        </KpiCard>

        <KpiCard
          active={activeTab === 'upcoming' && statusFilter === 'at_risk'}
          onClick={() => selectKpi('upcoming', 'at_risk')}
        >
          <AlertTriangle className="text-aurea-rose h-[17px] w-[17px]" strokeWidth={1.75} />
          <div>
            <p className="aurea-display text-[32px] tabular-nums text-aurea-ink">{atRiskCount}</p>
            <p className="aurea-eyebrow">At Risk</p>
          </div>
        </KpiCard>

        <KpiCard
          active={activeTab === 'analytics'}
          onClick={() => selectKpi('analytics', 'all')}
        >
          <div className="bg-aurea-surface-2 rounded-lg p-1.5 flex items-center justify-center">
            {noShowRate > 10
              ? <TrendingDown className="h-[17px] w-[17px] text-aurea-rose" strokeWidth={1.75} />
              : <TrendingUp className="h-[17px] w-[17px] text-aurea-primary" strokeWidth={1.75} />}
          </div>
          <div>
            <p className="aurea-display text-[32px] tabular-nums text-aurea-ink">{noShowRate}%</p>
            <p className="aurea-eyebrow">No-Show Rate</p>
          </div>
        </KpiCard>
      </div>

      {/* ── Tabs ── */}
      <div className="flex items-center gap-1 border-b pb-0">
        {([
          { key: 'calendar', label: 'Calendar', icon: CalendarDays, count: appointments.length },
          { key: 'upcoming', label: 'Upcoming', icon: Calendar, count: upcomingApts.length },
          { key: 'today', label: 'Today', icon: Clock, count: todayApts.length },
          { key: 'reminders', label: 'Reminder Log', icon: Send, count: reminders.length },
          { key: 'analytics', label: 'No-Show Analytics', icon: BarChart3 },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === tab.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-aurea-border'
            }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
            {'count' in tab && tab.count !== undefined && (
              <Badge variant="secondary" className="ml-1 text-xs h-5 min-w-5 flex items-center justify-center">
                {tab.count}
              </Badge>
            )}
          </button>
        ))}
      </div>

      {/* ── Status Filters (Upcoming/Today tabs) ── */}
      {(activeTab === 'upcoming' || activeTab === 'today') && (
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          {([
            { key: 'all', label: 'All', icon: null },
            { key: 'confirmed', label: 'Confirmed', icon: CheckCircle2 },
            { key: 'pending', label: 'Pending', icon: Clock },
            { key: 'at_risk', label: 'At Risk', icon: AlertTriangle },
          ] as const).map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full transition-colors ${
                statusFilter === f.key
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-secondary-foreground hover:bg-accent'
              }`}
            >
              {f.icon && <f.icon className="h-3.5 w-3.5" />}
              {f.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Content ── */}
      {activeTab === 'calendar' ? (
        <AppointmentsCalendar
          appointments={appointments}
          defaultView="month"
        />
      ) : activeTab === 'upcoming' || activeTab === 'today' ? (
        <div className="space-y-3">
          {displayApts.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center py-12">
                <Calendar className="h-10 w-10 text-muted-foreground mb-3" />
                <p className="font-medium">
                  {activeTab === 'today' ? 'No appointments today' : 'No upcoming appointments'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {activeTab === 'today'
                    ? 'Enjoy a free day!'
                    : 'Appointments will appear here when leads are scheduled'}
                </p>
              </CardContent>
            </Card>
          ) : (
            displayApts.map((apt) => (
              <AppointmentCard
                key={apt.id}
                appointment={apt}
                reminders={reminders.filter(r => r.appointment_id === apt.id)}
                onConfirm={handleConfirm}
                onStatusChange={handleStatusChange}
                onSendReminder={handleSendReminder}
                isLoading={actionLoading === apt.id || actionLoading === `reminder-${apt.id}`}
              />
            ))
          )}
        </div>
      ) : activeTab === 'reminders' ? (
        <ReminderLogTab reminders={reminders} appointments={appointments} />
      ) : (
        <NoShowAnalyticsTab appointments={appointments} reminders={reminders} />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// APPOINTMENT CARD COMPONENT
// ═══════════════════════════════════════════════════════════════

function AppointmentCard({
  appointment: apt,
  reminders,
  onConfirm,
  onStatusChange,
  onSendReminder,
  isLoading,
}: {
  appointment: AppointmentData
  reminders: ReminderData[]
  onConfirm: (id: string) => void
  onStatusChange: (id: string, status: string) => void
  onSendReminder: (id: string) => void
  isLoading: boolean
}) {
  const lead = apt.lead
  const aptDate = new Date(apt.scheduled_at)
  const isToday = isSameDay(aptDate, new Date())
  const isPast = aptDate < new Date()

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="flex flex-col lg:flex-row">
          {/* ── Left: Lead & Appointment Info ── */}
          <div className="flex-1 p-5">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-aurea-surface-2 flex items-center justify-center">
                  <User className="h-5 w-5 text-aurea-ink-3" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm">
                    {lead?.first_name} {lead?.last_name || ''}
                  </h3>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                    {lead?.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="h-3 w-3" /> {lead.phone}
                      </span>
                    )}
                    {lead?.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="h-3 w-3" /> {lead.email}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <StatusBadge status={apt.status} />
                {apt.confirmation_received && (
                  <Badge variant="outline" className="inline-flex items-center gap-1 bg-aurea-primary/10 text-aurea-primary border-aurea-primary/20 text-xs">
                    <CheckCircle2 className="h-3 w-3" />
                    Confirmed
                    {apt.confirmed_via && (
                      <span className="ml-0.5 opacity-70">
                        via {apt.confirmed_via.replace('_', ' ')}
                      </span>
                    )}
                  </Badge>
                )}
                {apt.reschedule_requested && (
                  <Badge variant="outline" className="inline-flex items-center gap-1 bg-aurea-amber/10 text-aurea-amber border-aurea-amber/20 text-xs">
                    <RefreshCw className="h-3 w-3" />
                    Reschedule Requested
                  </Badge>
                )}
                <RiskBadge score={apt.no_show_risk_score} />
              </div>
            </div>

            {/* Appointment Details */}
            <div className="flex items-center gap-4 text-sm mb-3">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Calendar className="h-3.5 w-3.5" />
                <span className={isToday ? 'text-aurea-primary font-semibold' : ''}>
                  {formatDate(apt.scheduled_at)}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                <span>{formatTime(apt.scheduled_at)}</span>
              </div>
              <Badge variant="secondary" className="text-xs capitalize">
                {apt.type.replace('_', ' ')}
              </Badge>
              {apt.location && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5" />
                  <span className="truncate max-w-[200px]">{apt.location}</span>
                </div>
              )}
            </div>

            {/* Reminder Timeline */}
            <ReminderTimeline appointment={apt} reminders={reminders} />
          </div>

          {/* ── Right: Actions ── */}
          {!isPast && (
            <div className="flex flex-row lg:flex-col items-stretch gap-1.5 p-3 lg:p-4 border-t lg:border-t-0 lg:border-l bg-muted/30 lg:w-[180px]">
              {!apt.confirmation_received && (
                <Button
                  size="sm"
                  className="flex-1 lg:flex-none text-xs bg-aurea-primary hover:bg-aurea-primary/90"
                  onClick={() => onConfirm(apt.id)}
                  disabled={isLoading}
                >
                  {isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
                  Confirm
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="flex-1 lg:flex-none text-xs"
                onClick={() => onSendReminder(apt.id)}
                disabled={isLoading}
              >
                {isLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3 mr-1" />}
                Send Reminder
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1 lg:flex-none text-xs text-aurea-amber hover:text-aurea-amber/80"
                onClick={() => onStatusChange(apt.id, 'rescheduled')}
                disabled={isLoading}
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Reschedule
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1 lg:flex-none text-xs text-aurea-rose hover:text-aurea-rose/80"
                onClick={() => onStatusChange(apt.id, 'no_show')}
                disabled={isLoading}
              >
                <XCircle className="h-3 w-3 mr-1" />
                No-Show
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ═══════════════════════════════════════════════════════════════
// REMINDER TIMELINE COMPONENT
// ═══════════════════════════════════════════════════════════════

function ReminderTimeline({
  appointment,
  reminders,
}: {
  appointment: AppointmentData
  reminders: ReminderData[]
}) {
  const stages = [
    { key: '72h', label: '72h Email', icon: Mail, sent: appointment.reminder_sent_72h, channel: 'email' },
    { key: '24h', label: '24h SMS+Email', icon: MessageSquare, sent: appointment.reminder_sent_24h, channel: 'sms' },
    { key: '2h', label: '2h AI Call', icon: PhoneCall, sent: appointment.reminder_sent_2h || appointment.confirmation_call_made, channel: 'voice_confirmation' },
    { key: '1h', label: '1h SMS', icon: MessageSquare, sent: appointment.reminder_sent_1h, channel: 'sms' },
  ]

  return (
    <div className="flex items-center gap-0 mt-2">
      {stages.map((stage, i) => {
        const stageReminders = reminders.filter(r => r.reminder_type === stage.key)
        const confirmed = stageReminders.some(r => r.confirmation_status === 'confirmed')
        const failed = stageReminders.some(r => r.status === 'failed')
        const sent = stage.sent || stageReminders.some(r => r.status === 'sent')

        let dotColor = 'bg-muted text-muted-foreground'
        let label = 'Pending'
        if (confirmed) {
          dotColor = 'bg-aurea-primary/10 text-aurea-primary ring-2 ring-aurea-primary/20'
          label = 'Confirmed'
        } else if (sent) {
          dotColor = 'bg-aurea-surface-2 text-aurea-ink-2'
          label = 'Sent'
        } else if (failed) {
          dotColor = 'bg-aurea-rose/10 text-aurea-rose'
          label = 'Failed'
        }

        return (
          <div key={stage.key} className="flex items-center">
            <div className="flex flex-col items-center gap-0.5" title={`${stage.label}: ${label}`}>
              <div className={`h-7 w-7 rounded-full flex items-center justify-center ${dotColor} transition-all duration-300`}>
                <stage.icon className="h-3.5 w-3.5" />
              </div>
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">{stage.label}</span>
            </div>
            {i < stages.length - 1 && (
              <div className={`h-px w-6 mx-1 mt-[-14px] ${sent ? 'bg-aurea-primary/30' : 'bg-muted'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// REMINDER LOG TAB
// ═══════════════════════════════════════════════════════════════

function ReminderLogTab({
  reminders,
  appointments,
}: {
  reminders: ReminderData[]
  appointments: AppointmentData[]
}) {
  const aptMap = new Map(appointments.map(a => [a.id, a]))

  if (reminders.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center py-12">
          <Send className="h-10 w-10 text-muted-foreground mb-3" />
          <p className="font-medium">No reminders sent yet</p>
          <p className="text-sm text-muted-foreground">
            Reminders will be logged here as they are sent
          </p>
        </CardContent>
      </Card>
    )
  }

  // Group by appointment
  const grouped = new Map<string, ReminderData[]>()
  for (const r of reminders) {
    const list = grouped.get(r.appointment_id) || []
    list.push(r)
    grouped.set(r.appointment_id, list)
  }

  return (
    <div className="space-y-4">
      {Array.from(grouped.entries()).map(([aptId, rems]) => {
        const apt = aptMap.get(aptId)
        return (
          <Card key={aptId}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <User className="h-4 w-4 text-muted-foreground" />
                  {apt?.lead?.first_name} {apt?.lead?.last_name || ''}
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  <span className="text-muted-foreground font-normal capitalize">
                    {apt?.type?.replace('_', ' ')}
                  </span>
                </CardTitle>
                {apt && (
                  <span className="text-xs text-muted-foreground">
                    {formatDate(apt.scheduled_at)} at {formatTime(apt.scheduled_at)}
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="space-y-2">
                {rems.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()).map((r) => (
                  <div key={r.id} className="flex items-center gap-3 py-1.5 text-sm border-b last:border-0">
                    <ChannelIcon channel={r.channel} />
                    <Badge variant="secondary" className="text-xs capitalize">
                      {r.reminder_type}
                    </Badge>
                    <ReminderStatusBadge status={r.status} />
                    {r.confirmation_status !== 'pending' && (
                      <Badge
                        variant="outline"
                        className={`text-xs ${
                          r.confirmation_status === 'confirmed'
                            ? 'text-aurea-primary border-aurea-primary/20'
                            : r.confirmation_status === 'declined'
                            ? 'text-aurea-rose border-aurea-rose/20'
                            : 'text-aurea-amber border-aurea-amber/20'
                        }`}
                      >
                        {r.confirmation_status}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto">
                      {r.sent_at ? formatRelative(r.sent_at) : 'Pending'}
                    </span>
                    {r.error_message && (
                      <span className="inline-flex items-center gap-1 text-xs text-aurea-rose max-w-[200px] truncate" title={r.error_message}>
                        <AlertTriangle className="h-3 w-3 shrink-0" />
                        <span className="truncate">{r.error_message}</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// NO-SHOW ANALYTICS TAB
// ═══════════════════════════════════════════════════════════════

function NoShowAnalyticsTab({
  appointments,
  reminders,
}: {
  appointments: AppointmentData[]
  reminders: ReminderData[]
}) {
  const now = new Date()
  const pastApts = appointments.filter(a => new Date(a.scheduled_at) < now)
  const noShows = pastApts.filter(a => a.status === 'no_show')
  const completed = pastApts.filter(a => a.status === 'completed')
  const canceled = pastApts.filter(a => a.status === 'canceled')

  const totalPast = pastApts.length || 1
  const noShowRate = Math.round((noShows.length / totalPast) * 100)
  const completionRate = Math.round((completed.length / totalPast) * 100)
  const cancelRate = Math.round((canceled.length / totalPast) * 100)

  // Channel effectiveness
  const smsReminders = reminders.filter(r => r.channel === 'sms')
  const emailReminders = reminders.filter(r => r.channel === 'email')
  const voiceReminders = reminders.filter(r => r.channel === 'voice_confirmation')

  const smsConfirmed = smsReminders.filter(r => r.confirmation_status === 'confirmed').length
  const emailConfirmed = emailReminders.filter(r => r.confirmation_status === 'confirmed').length
  const voiceConfirmed = voiceReminders.filter(r => r.confirmation_status === 'confirmed').length

  return (
    <div className="space-y-6">
      {/* Overview Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4 text-center">
            <p className="aurea-display text-[36px] tabular-nums text-aurea-ink">{pastApts.length}</p>
            <p className="text-[12px] text-aurea-ink-3 mt-1">Total Past Appointments</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4 text-center">
            <p className="aurea-display text-[36px] tabular-nums text-aurea-primary">{completionRate}%</p>
            <p className="text-[12px] text-aurea-ink-3 mt-1">Completion Rate</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4 text-center">
            <p className={`aurea-display text-[36px] tabular-nums ${noShowRate > 15 ? 'text-aurea-rose' : noShowRate > 5 ? 'text-aurea-amber' : 'text-aurea-primary'}`}>
              {noShowRate}%
            </p>
            <p className="text-[12px] text-aurea-ink-3 mt-1">No-Show Rate</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4 text-center">
            <p className="aurea-display text-[36px] tabular-nums text-aurea-ink-3">{cancelRate}%</p>
            <p className="text-[12px] text-aurea-ink-3 mt-1">Cancellation Rate</p>
          </CardContent>
        </Card>
      </div>

      {/* Channel Effectiveness */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Channel Effectiveness</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <ChannelEffectivenessBar
              label="SMS Reminders"
              icon={MessageSquare}
              total={smsReminders.length}
              confirmed={smsConfirmed}
              color="bg-aurea-ink-2"
            />
            <ChannelEffectivenessBar
              label="Email Reminders"
              icon={Mail}
              total={emailReminders.length}
              confirmed={emailConfirmed}
              color="bg-aurea-ink-3"
            />
            <ChannelEffectivenessBar
              label="AI Voice Calls"
              icon={PhoneCall}
              total={voiceReminders.length}
              confirmed={voiceConfirmed}
              color="bg-aurea-primary"
            />
          </div>
        </CardContent>
      </Card>

      {/* Recent No-Shows */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent No-Shows</CardTitle>
        </CardHeader>
        <CardContent>
          {noShows.length === 0 ? (
            <p className="inline-flex items-center gap-1.5 w-full justify-center text-sm text-muted-foreground py-4 text-center">
              <CheckCircle2 className="h-4 w-4 text-aurea-primary" />
              No no-shows! Great job with your reminder system.
            </p>
          ) : (
            <div className="space-y-2">
              {noShows.slice(0, 10).map((apt) => (
                <div key={apt.id} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div className="flex items-center gap-2">
                    <User className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {apt.lead?.first_name} {apt.lead?.last_name || ''}
                    </span>
                    <Badge variant="secondary" className="text-xs capitalize">
                      {apt.type.replace('_', ' ')}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <RiskBadge score={apt.no_show_risk_score} />
                    <span className="text-xs text-muted-foreground">
                      {formatDate(apt.scheduled_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════

function KpiCard({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`aurea-card p-4 text-left w-full cursor-pointer transition-all hover:border-aurea-primary/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-aurea-primary/40 ${
        active ? 'border-aurea-primary/60 ring-1 ring-aurea-primary/30' : ''
      }`}
    >
      <div className="flex items-center gap-3">{children}</div>
    </button>
  )
}

function ChannelEffectivenessBar({ label, icon: Icon, total, confirmed, color }: { label: string; icon: LucideIcon; total: number; confirmed: number; color: string }) {
  const pct = total > 0 ? Math.round((confirmed / total) * 100) : 0

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {label}
        </span>
        <span className="text-xs text-muted-foreground">
          {confirmed}/{total} confirmed ({pct}%)
        </span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    scheduled: 'bg-aurea-surface-2 text-aurea-ink-2',
    confirmed: 'bg-aurea-primary/10 text-aurea-primary',
    completed: 'bg-aurea-surface-2 text-aurea-ink-3',
    no_show: 'bg-aurea-rose/10 text-aurea-rose',
    canceled: 'bg-aurea-surface-2 text-aurea-ink-3',
    rescheduled: 'bg-aurea-amber/10 text-aurea-amber',
  }

  return (
    <Badge className={`text-xs font-medium ${colors[status] || 'bg-aurea-surface-2 text-aurea-ink-3'}`}>
      {status.replace('_', ' ')}
    </Badge>
  )
}

function RiskBadge({ score }: { score: number }) {
  if (score <= 0) return null

  let color = 'bg-aurea-surface-2 text-aurea-ink-3'
  let label = 'Low Risk'
  if (score >= 70) {
    color = 'bg-aurea-rose/10 text-aurea-rose'
    label = 'High Risk'
  } else if (score >= 40) {
    color = 'bg-aurea-amber/10 text-aurea-amber'
    label = 'Med Risk'
  } else if (score > 10) {
    color = 'bg-aurea-surface-2 text-aurea-ink-3'
    label = 'Low Risk'
  } else {
    return null
  }

  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${color}`}>
      {label} ({score})
    </span>
  )
}

function ReminderStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    sent: 'bg-aurea-surface-2 text-aurea-ink-2',
    delivered: 'bg-aurea-primary/10 text-aurea-primary',
    failed: 'bg-aurea-rose/10 text-aurea-rose',
    skipped: 'bg-aurea-surface-2 text-aurea-ink-3',
    pending: 'bg-aurea-amber/10 text-aurea-amber',
  }

  return (
    <Badge className={`text-xs ${styles[status] || 'bg-aurea-surface-2 text-aurea-ink-3'}`}>
      {status}
    </Badge>
  )
}

function ChannelIcon({ channel }: { channel: string }) {
  switch (channel) {
    case 'sms':
      return <MessageSquare className="h-4 w-4 text-aurea-ink-3" />
    case 'email':
      return <Mail className="h-4 w-4 text-aurea-ink-2" />
    case 'voice_confirmation':
      return <PhoneCall className="h-4 w-4 text-aurea-primary" />
    default:
      return <Send className="h-4 w-4 text-muted-foreground" />
  }
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
