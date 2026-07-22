'use client'

import { useState, useRef, useEffect, useMemo } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useRouter } from 'next/navigation'
import {
  DEFAULT_PRACTICE_TIMEZONE,
  zonedDayKey,
  zonedDayDivider,
  zonedTimeLabel,
  zonedDateTimeLabel,
} from '@/lib/time/zoned'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Send,
  Brain,
  Loader2,
  Sparkles,
  User,
  Bot,
  Heart,
  Eye,
  ChevronLeft,
  ChevronDown,
  Shield,
  AlertTriangle,
  MessageSquare,
  Mail,
  MoreVertical,
  Paperclip,
  PanelRightClose,
  PanelRightOpen,
  Zap,
  TrendingUp,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
// NB: `@/lib/attribution` also exports a `channelLabel`, but that one names a
// *marketing* channel (paid social, organic…). Import the registry's metadata
// accessor instead of aliasing, so the two never get confused at a call site.
import { channelMeta, type ConversationChannel } from '@/lib/channels'
import { stripEmailUnsubscribeFooter } from '@/lib/messaging/email-cleanup'
import { ChannelIcon } from '@/components/crm/channel-icon'
import type { Conversation, Message, Lead, AgentType, VoiceCall, ConversationAnalysis, PatientProfile, PipelineStage } from '@/types/database'
import { AgentMessageLabel } from './agent-indicator'
import { AIModeToggle } from './ai-mode-toggle'
import { LeadActions } from './lead-actions'
import { StageSelect } from './stage-select'
import { LiveCallIndicator, LiveCallPanel } from './live-call-panel'
import { CallCard } from './call-card'
import { LeadNotesPanel, type LeadNote } from './lead-notes-panel'
import { LeadContactField } from './lead-contact-field'
import { useLiveCall } from '@/lib/hooks/use-live-call'
import { useConversationPresence } from '@/lib/hooks/use-conversation-presence'
import { sendBlockMessage } from '@/lib/messaging/send-block-messages'
import { isWindowedChannel, socialWindowState, suggestFallback } from '@/lib/messaging/social-window'
import { SlaCountdown } from './sla-countdown'
import { channelLabel, formatCampaignAttribution } from '@/lib/attribution'
import { classifyLeadServiceLines, SERVICE_LINES } from '@/lib/leads/service-line'

// ── Thread shaping ──────────────────────────────────────────
// Consecutive messages from the same sender within this window render as one
// visual group (single meta line, tight bubbles) instead of repeating labels.
const GROUP_WINDOW_MS = 8 * 60 * 1000

// Bounds for the drag-resizable composer (px). Min keeps ~2 lines visible; max
// stops the input from swallowing the whole thread on short screens.
const COMPOSER_MIN_H = 72
const COMPOSER_MAX_H = 520

// Bounds for the drag-resizable intelligence panel (px). Min keeps the metrics
// legible; max stops the panel from crowding out the thread on wide screens.
const PANEL_MIN_W = 300
const PANEL_MAX_W = 720
const PANEL_DEFAULT_W = 380

// Base UI's <SelectValue> renders the raw value, so map each value → trigger label.
const AI_MODE_LABELS: Record<string, string> = {
  education: 'Educate',
  objection_handling: 'Objections',
  appointment_scheduling: 'Schedule',
  follow_up: 'Follow Up',
}

type ThreadItem =
  | { type: 'day'; key: string; label: string }
  | { type: 'group'; key: string; messages: Message[] }
  | { type: 'call'; key: string; call: VoiceCall }

function agentOf(msg: Message): string {
  return ((msg.metadata as Record<string, string> | null)?.agent) || ''
}

// A completed call sits in the timeline at the moment it ended.
function callTime(call: VoiceCall): number {
  return new Date(call.ended_at || call.started_at || call.created_at).getTime()
}

function buildThread(messages: Message[], calls: VoiceCall[], timeZone: string): ThreadItem[] {
  // Interleave messages and finished calls into one time-ordered stream. Calls
  // are standalone cards, so they break any in-progress message group.
  type Ev = { t: number; msg?: Message; call?: VoiceCall }
  const events: Ev[] = [
    ...messages.map((m) => ({ t: new Date(m.created_at).getTime(), msg: m })),
    ...calls.map((c) => ({ t: callTime(c), call: c })),
  ].sort((a, b) => a.t - b.t)

  const items: ThreadItem[] = []
  let group: Message[] = []
  let lastDay = ''

  const flush = () => {
    if (group.length) {
      items.push({ type: 'group', key: group[0].id, messages: group })
      group = []
    }
  }

  for (const ev of events) {
    const d = new Date(ev.t)
    // Day boundaries are computed in the PRACTICE timezone, not the ambient one,
    // so the server (UTC) and the browser agree on which day a message lands in.
    const day = zonedDayKey(d, timeZone)
    if (day !== lastDay) {
      flush()
      items.push({
        type: 'day',
        key: day,
        label: zonedDayDivider(d, timeZone),
      })
      lastDay = day
    }

    if (ev.call) {
      flush()
      items.push({ type: 'call', key: `call-${ev.call.id}`, call: ev.call })
      continue
    }

    const msg = ev.msg!
    const prev = group[group.length - 1]
    const continues =
      prev &&
      prev.direction === msg.direction &&
      prev.sender_type === msg.sender_type &&
      // Keep channels apart: an email and a text should never share one group,
      // even back-to-back, so each reads as its own kind of event.
      prev.channel === msg.channel &&
      agentOf(prev) === agentOf(msg) &&
      d.getTime() - new Date(prev.created_at).getTime() < GROUP_WINDOW_MS
    if (!continues) flush()
    group.push(msg)
  }
  flush()
  return items
}

export function ConversationThread({
  lead,
  stages = [],
  conversation,
  messages: initialMessages,
  calls = [],
  prequalEnabled = false,
  noShowFeeEnabled = false,
  backHref = '/conversations',
  savedAnalysis = null,
  patientProfile = null,
  timeZone = DEFAULT_PRACTICE_TIMEZONE,
  embedded = false,
  canTrainAi = false,
  notes = [],
  currentUserId = null,
}: {
  lead: Lead
  /** The org's pipeline stages, for the stage control in the toolbar + summary
   *  rail. Empty (the default) hides both, so a caller that hasn't loaded them
   *  degrades to the previous read-only stage text rather than an empty menu. */
  stages?: PipelineStage[]
  /** The thread's conversation. `null` when the lead has no conversation yet:
   *  the composer still renders and the first send find-or-creates the row
   *  server-side (via lead_id), then we refresh to hydrate the real thread. */
  conversation: Conversation | null
  messages: Message[]
  calls?: VoiceCall[]
  prequalEnabled?: boolean
  noShowFeeEnabled?: boolean
  /** Admin roles only (computed server-side): shows the per-call "Use for AI
   *  training" control on call cards. The API re-checks the role. */
  canTrainAi?: boolean
  /** Where the header back-arrow returns to. Defaults to the conversations
   *  inbox; the lead surface passes '/leads' so the arrow retraces the click. */
  backHref?: string
  /** Embedded in the messenger shell — the inbox rail frames + navigates, so
   *  drop this thread's own card border and header back arrow. */
  embedded?: boolean
  /** Practice IANA timezone (from booking_settings). All thread timestamps
   *  render in this zone so SSR (UTC on Vercel) and the browser agree. */
  timeZone?: string
  /** Persisted analysis for this conversation (from `conversation_analyses`).
   *  Seeds the side panel so insights survive reloads without re-analyzing. */
  savedAnalysis?: ConversationAnalysis | null
  /** Persisted patient psychology profile — powers the always-on Lead Summary. */
  patientProfile?: PatientProfile | null
  /** Manual team notes for this lead, rendered in the intelligence rail. */
  notes?: LeadNote[]
  /** Viewer's user id — notes only expose edit/delete on the author's own rows. */
  currentUserId?: string | null
}) {
  const router = useRouter()
  const [messages, setMessages] = useState(initialMessages)

  // Keep local state in sync when the server hands down fresh messages (page
  // refresh / router.refresh) — otherwise a patient's reply never appears and
  // staff double-text. Merge instead of replace so messages appended
  // optimistically by handleSend (real persisted rows from the send API, keyed
  // by id) aren't dropped if the server list hasn't caught up yet.
  useEffect(() => {
    setMessages((prev) => {
      const serverIds = new Set(initialMessages.map((m) => m.id))
      const localOnly = prev.filter((m) => !serverIds.has(m.id))
      return localOnly.length ? [...initialMessages, ...localOnly] : initialMessages
    })
  }, [initialMessages])

  // Pipeline stage, mirrored locally so staff can move a lead without leaving
  // the thread — stages get worked straight off a manual call or text, and the
  // only other control lives on the Details tab. Optimistic with revert, like
  // the kanban board: the move *is* the interaction, so it has to feel instant.
  // Re-seeds from the server so a move made elsewhere shows up here too.
  const [stageId, setStageId] = useState<string | null>(lead.stage_id ?? null)
  const [stage, setStage] = useState<PipelineStage | null>(lead.pipeline_stage ?? null)
  const [movingStage, setMovingStage] = useState(false)

  // Phone/email are editable inline in the header, but `lead` is a prop that
  // only changes on a route refresh — mirror them so a save shows immediately
  // and, more importantly, unblocks the SMS/email composer toggles right away.
  const [contact, setContact] = useState<{ phone: string | null; email: string | null }>({
    phone: lead.phone ?? null,
    email: lead.email ?? null,
  })

  useEffect(() => {
    setStageId(lead.stage_id ?? null)
    setStage(lead.pipeline_stage ?? null)
  }, [lead.stage_id, lead.pipeline_stage])

  useEffect(() => {
    setContact({ phone: lead.phone ?? null, email: lead.email ?? null })
  }, [lead.phone, lead.email])

  async function moveStage(nextId: string) {
    if (!nextId || nextId === stageId || movingStage) return
    const target = stages.find((s) => s.id === nextId) ?? null
    const previous = { id: stageId, row: stage }
    setStageId(nextId)
    setStage(target)
    setMovingStage(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage_id: nextId }),
      })
      if (!res.ok) throw new Error(`stage move failed: ${res.status}`)
      const { lead: updated } = await res.json()
      setStageId(updated.stage_id ?? nextId)
      setStage(updated.pipeline_stage ?? target)
      toast.success(`Moved to ${target?.name ?? 'new stage'}`)
      // The move writes a stage_changed activity and may fire funnel/campaign
      // automations — refresh so Timeline and Details agree with what's shown here.
      router.refresh()
    } catch {
      setStageId(previous.id)
      setStage(previous.row)
      toast.error('Could not change the stage')
    } finally {
      setMovingStage(false)
    }
  }

  const [draft, setDraft] = useState('')
  // D4 presence heartbeat: tells the staff notifier this user has the thread
  // open, so inbound-message pings are suppressed while they're looking.
  // No-ops until a conversation exists (new-lead composer).
  useConversationPresence(conversation?.id)
  // Which channel the composer sends on. Seeded from the thread's channel but
  // switchable inline for SMS/email, so text + email both happen here.
  //
  // Social threads are LOCKED to their own channel. This used to seed to 'sms'
  // for anything that wasn't email, so replying to a Messenger DM quietly sent
  // a *text message* to the lead's phone — a misroute and a consent problem
  // (DMing a page is not permission to text).
  const threadMeta = channelMeta(conversation?.channel)
  const socialLocked = threadMeta.isSocial
  const [sendChannel, setSendChannel] = useState<ConversationChannel>(
    threadMeta.canSend ? threadMeta.key : 'sms'
  )
  // A thread can change under the composer (navigating between threads reuses
  // this component), so re-lock when the underlying channel changes.
  useEffect(() => {
    if (threadMeta.canSend && threadMeta.isSocial) setSendChannel(threadMeta.key)
  }, [threadMeta.key, threadMeta.canSend, threadMeta.isSocial])
  const [sending, setSending] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [aiMode, setAiMode] = useState<string>('education')
  const [analyzing, setAnalyzing] = useState(false)
  const [generatingFollowUp, setGeneratingFollowUp] = useState(false)
  // Seed from persisted rows so insights + summary show instantly on load. The
  // API nests these under conversation_analysis / patient_profile, so the DB
  // rows are shaped the same way here to keep one rendering path.
  const [analysisResult, setAnalysisResult] = useState<Record<string, unknown> | null>(
    savedAnalysis || patientProfile
      ? { conversation_analysis: savedAnalysis, patient_profile: patientProfile }
      : null
  )
  const [profile, setProfile] = useState<PatientProfile | null>(patientProfile)
  const [followUpResult, setFollowUpResult] = useState<Record<string, unknown> | null>(null)
  // Side panel open by default — the Lead Summary should always be at hand.
  // Persisted per-user like the composer height below.
  const [showPanel, setShowPanel] = useState(true)
  const [activeAgent, setActiveAgent] = useState<AgentType>(conversation?.active_agent || 'setter')
  const [agentNotes, setAgentNotes] = useState<string | null>(null)
  const [draftBlock, setDraftBlock] = useState<{ kind: string; reason: string; guidance: string | null } | null>(null)
  const [techniquesUsed, setTechniquesUsed] = useState<Array<{ technique_id: string; confidence: number; effectiveness: string; context_note: string }>>([])
  const [leadAssessment, setLeadAssessment] = useState<{ engagement_temperature: number; resistance_level: number; buying_readiness: number; emotional_state: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Draggable composer height. Users writing long emails grab the grip above
  // the input and drag up; the message list (flex-1) yields the space. The last
  // size sticks across leads/sessions via localStorage.
  const [composerHeight, setComposerHeight] = useState(96)
  // Draggable panel width — grip on the panel's left edge. Sticks per-user.
  const [panelWidth, setPanelWidth] = useState(PANEL_DEFAULT_W)

  useEffect(() => {
    const saved = Number(window.localStorage.getItem('li-composer-height'))
    if (saved >= COMPOSER_MIN_H && saved <= COMPOSER_MAX_H) setComposerHeight(saved)
    const panel = window.localStorage.getItem('li-insights-panel')
    if (panel === '0') setShowPanel(false)
    const w = Number(window.localStorage.getItem('li-insights-width'))
    if (w >= PANEL_MIN_W && w <= PANEL_MAX_W) setPanelWidth(w)
  }, [])

  function togglePanel() {
    setShowPanel((v) => {
      const next = !v
      window.localStorage.setItem('li-insights-panel', next ? '1' : '0')
      return next
    })
  }

  function startComposerResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const startY = e.clientY
    const startH = composerHeight
    let latest = startH
    function onMove(ev: PointerEvent) {
      // Dragging up (clientY shrinks) grows the box.
      latest = Math.min(COMPOSER_MAX_H, Math.max(COMPOSER_MIN_H, startH + (startY - ev.clientY)))
      setComposerHeight(latest)
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.localStorage.setItem('li-composer-height', String(latest))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function resetComposerHeight() {
    setComposerHeight(96)
    window.localStorage.setItem('li-composer-height', '96')
  }

  function startPanelResize(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelWidth
    let latest = startW
    // Suppress text selection while dragging across the thread.
    document.body.style.userSelect = 'none'
    function onMove(ev: PointerEvent) {
      // Dragging left (clientX shrinks) grows the panel.
      latest = Math.min(PANEL_MAX_W, Math.max(PANEL_MIN_W, startW + (startX - ev.clientX)))
      setPanelWidth(latest)
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
      window.localStorage.setItem('li-insights-width', String(latest))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function resetPanelWidth() {
    setPanelWidth(PANEL_DEFAULT_W)
    window.localStorage.setItem('li-insights-width', String(PANEL_DEFAULT_W))
  }

  // Meta's reply window, recomputed whenever the thread grows — an inbound
  // message arriving over Realtime reopens the window and clears the warning
  // without a refresh. Null on SMS/email, which have no such constraint.
  const socialWindow = useMemo(
    () => (isWindowedChannel(sendChannel) ? socialWindowState(messages) : null),
    [sendChannel, messages]
  )
  const windowFallback = useMemo(() => suggestFallback(contact), [contact])

  // Live phone-call state (ongoing-call indicator + streaming transcript).
  const live = useLiveCall(lead.id)

  // Nothing to show in the message band at all. Drives the band's alignment:
  // an empty thread centres its placeholder, a populated one starts at the top.
  const threadIsEmpty = messages.length === 0 && calls.length === 0 && live.status === 'idle'

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  async function handleSend() {
    if (!draft.trim()) return
    setSending(true)

    try {
      // Social replies relay through GHL (it owns the Meta connection); SMS and
      // email go out on LI's own transports.
      const endpoint =
        sendChannel === 'sms'
          ? '/api/sms/send'
          : sendChannel === 'email'
            ? '/api/email/send'
            : '/api/social/send'
      const payload =
        sendChannel === 'sms'
          ? { lead_id: lead.id, message: draft }
          : sendChannel === 'email'
            ? { lead_id: lead.id, subject: conversation?.subject || 'Follow up', body: draft }
            : { lead_id: lead.id, conversation_id: conversation?.id, channel: sendChannel, message: draft }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = await res.json().catch(() => null)

      if (!res.ok) {
        // The API returns { error, reason } — surface the real cause (consent
        // block, quiet hours, compliance, etc.) instead of a generic failure.
        toast.error(sendBlockMessage(data, 'Failed to send message'))
        return
      }

      setMessages((prev) => [...prev, data.message])
      setDraft('')
      toast.success('Message sent')
      // First send on a lead with no prior thread just created the conversation
      // server-side — refresh so the surface hydrates with the real thread
      // (AI mode, insights, presence, SLA all come online).
      if (!conversation) router.refresh()
    } catch {
      toast.error('Failed to send message')
    } finally {
      setSending(false)
    }
  }

  async function generateAIMessage() {
    // The agent router keys off a conversation; nothing to draft against yet.
    if (!conversation) return
    setGenerating(true)
    setAgentNotes(null)
    setDraftBlock(null)
    try {
      // Use agent system for smart routing between Setter/Closer
      const res = await fetch('/api/ai/agent-respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversation.id,
        }),
      })

      if (!res.ok) throw new Error('AI generation failed')

      const data = await res.json()

      // The route can decline to draft: the lead needs a human (escalation) or
      // the thread already closed. Surface that instead of a tone-deaf message.
      if (data.blocked) {
        setDraftBlock({ kind: data.block_kind, reason: data.reason, guidance: data.guidance ?? null })
        toast.message(
          data.block_kind === 'escalation' ? 'Draft held — this lead needs a human' : 'No draft — conversation already closed'
        )
        return
      }

      setDraft(data.message)
      if (data.agent) setActiveAgent(data.agent)
      if (data.internal_notes) setAgentNotes(data.internal_notes)
      if (data.techniques_used) setTechniquesUsed(data.techniques_used)
      if (data.lead_assessment) setLeadAssessment(data.lead_assessment)
      toast.success(`${data.agent === 'closer' ? 'Closer' : 'Setter'} agent draft — review and send`)
    } catch {
      // Fallback to legacy engage endpoint
      try {
        const res = await fetch('/api/ai/engage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead_id: lead.id,
            conversation_id: conversation.id,
            mode: aiMode,
            channel: conversation.channel,
          }),
        })
        if (res.ok) {
          const { message } = await res.json()
          setDraft(message)
          toast.success('AI draft generated (fallback) — review and send')
        } else {
          throw new Error('Fallback also failed')
        }
      } catch {
        toast.error('Failed to generate AI message')
      }
    } finally {
      setGenerating(false)
    }
  }

  async function analyzeConversation() {
    if (!conversation) return
    if (messages.length < 2) {
      toast.error('Need at least 2 messages to analyze')
      return
    }
    setAnalyzing(true)
    // Open the panel now so each result appears as it streams in.
    setShowPanel(true)
    window.localStorage.setItem('li-insights-panel', '1')
    let gotResult = false
    try {
      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: conversation.id,
          lead_id: lead.id,
        }),
      })
      if (!res.ok || !res.body) throw new Error('Analysis failed')

      // Read the newline-delimited JSON stream: each agent's result lands the
      // moment it finishes, rather than waiting for both.
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line) continue
          const msg = JSON.parse(line) as { type: string; data?: unknown; message?: string }
          if (msg.type === 'conversation_analysis') {
            gotResult = true
            setAnalysisResult((prev) => ({ ...(prev ?? {}), conversation_analysis: msg.data }))
          } else if (msg.type === 'patient_profile') {
            gotResult = true
            setAnalysisResult((prev) => ({ ...(prev ?? {}), patient_profile: msg.data }))
            // Refresh the always-on summary with the newly-written profile.
            setProfile(msg.data as PatientProfile)
          } else if (msg.type === 'error') {
            toast.error(msg.message || 'Part of the analysis failed')
          }
        }
      }

      if (gotResult) toast.success('Conversation analyzed — insights saved')
      else throw new Error('No results')
    } catch {
      toast.error('Failed to analyze conversation')
    } finally {
      setAnalyzing(false)
    }
  }

  async function getFollowUpPlan() {
    if (!conversation) return
    setGeneratingFollowUp(true)
    try {
      const res = await fetch('/api/ai/follow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_id: lead.id,
          channel: conversation.channel,
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        if (err.error?.includes('No patient profile')) {
          toast.error('Analyze the conversation first to build a patient profile')
          return
        }
        throw new Error('Failed')
      }
      const data = await res.json()
      setFollowUpResult(data)
      // Pre-fill draft with the opening message
      if (data.follow_up?.opening_message) {
        setDraft(data.follow_up.opening_message)
      }
      setShowPanel(true)
      window.localStorage.setItem('li-insights-panel', '1')
      toast.success('Follow-up plan generated')
    } catch {
      toast.error('Failed to generate follow-up plan')
    } finally {
      setGeneratingFollowUp(false)
    }
  }

  const thread = buildThread(messages, calls, timeZone)
  const initials = `${lead.first_name?.[0] ?? ''}${lead.last_name?.[0] ?? ''}`.toUpperCase() || '?'
  const smsSegments = Math.max(1, Math.ceil(draft.length / 160))

  return (
    <div
      // `relative` anchors the mobile full-screen intelligence panel, which is
      // `absolute inset-0` below `lg`. No effect on the desktop layout.
      className={`relative flex h-full overflow-hidden bg-aurea-surface ${
        embedded ? '' : 'rounded-xl border border-aurea-border'
      }`}
    >
      {/* ── Chat column (header · messages · composer) ─────── */}
      <div className="flex min-w-0 flex-1 flex-col">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-aurea-border px-4 py-3 lg:px-5">
        <div className="flex min-w-0 items-center gap-3">
          {!embedded && (
            <Link
              href={backHref}
              aria-label="Back"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-aurea-border text-aurea-ink-3 transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink"
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
            </Link>
          )}
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-aurea-border bg-aurea-surface-2">
            <span className="aurea-display text-[14px] text-aurea-ink-2">{initials}</span>
          </div>
          <div className="min-w-0">
            <h3 className="aurea-display truncate text-[20px] text-aurea-ink">
              {lead.first_name} {lead.last_name}
            </h3>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-aurea-ink-3">
              <span className="inline-flex items-center gap-1 font-mono uppercase tracking-[0.12em]">
                <ChannelIcon channel={conversation?.channel ?? sendChannel} className="h-3 w-3" tinted />
                {channelMeta(conversation?.channel ?? sendChannel).label}
              </span>
              {/* Always rendered, even when empty — a social lead often arrives
                  with no phone or email, and this is where staff are looking when
                  the lead finally hands one over mid-thread. */}
              <span className="text-aurea-border-strong">·</span>
              <LeadContactField
                leadId={lead.id}
                field="phone"
                value={contact.phone}
                onSaved={(phone) => { setContact((c) => ({ ...c, phone })); router.refresh() }}
              />
              <span className="text-aurea-border-strong">·</span>
              <LeadContactField
                leadId={lead.id}
                field="email"
                value={contact.email}
                onSaved={(email) => { setContact((c) => ({ ...c, email })); router.refresh() }}
                className="max-w-[180px]"
              />
              <span className="text-aurea-border-strong">·</span>
              <span>{messages.length} messages</span>
              {conversation?.sentiment && (
                <>
                  <span className="text-aurea-border-strong">·</span>
                  <span className="capitalize">{conversation.sentiment}</span>
                </>
              )}
            </div>
            {/* Prominent, color-coded status pill directly under the name — the
                lead's pipeline stage at a glance, and one click to change it. */}
            {stages.length > 0 && (
              <div className="mt-1.5">
                <StageSelect
                  stages={stages}
                  value={stageId}
                  onChange={moveStage}
                  disabled={movingStage}
                  variant="pill"
                  aria-label="Change pipeline stage"
                />
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <LiveCallIndicator live={live} />
          {/* Call + DND live here; SMS/Email happen in the composer below, so
              suppress the modal buttons to keep everything in one surface. */}
          <LeadActions lead={lead} variant="compact" prequalEnabled={prequalEnabled} noShowFeeEnabled={noShowFeeEnabled} showMessaging={false} />
          {conversation && (
            <AIModeToggle
              conversationId={conversation.id}
              currentMode={conversation.ai_mode || 'off'}
              size="sm"
              showLabel={false}
            />
          )}
          {/* The stage picker now lives as a prominent pill under the lead name
              (see header above), so it is not duplicated in this toolbar. */}
          <div className="hidden h-6 w-px bg-aurea-border md:block" />
          {/* Analyze + Smart Follow-Up don't fit a phone header — below md they
              fold into the overflow menu at the end of this row. */}
          <Button
            variant="outline"
            size="sm"
            onClick={analyzeConversation}
            disabled={analyzing || !conversation || messages.length < 2}
            className="hidden gap-1.5 md:inline-flex"
          >
            {analyzing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" strokeWidth={1.75} />}
            Analyze
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={getFollowUpPlan}
            disabled={generatingFollowUp || !conversation}
            className="hidden gap-1.5 md:inline-flex"
          >
            {generatingFollowUp ? <Loader2 className="h-3 w-3 animate-spin" /> : <Heart className="h-3 w-3" strokeWidth={1.75} />}
            Smart Follow-Up
          </Button>
          <Button
            variant={showPanel ? 'default' : 'ghost'}
            size="sm"
            onClick={togglePanel}
            aria-pressed={showPanel}
            className="gap-1.5"
            title={showPanel ? 'Hide intelligence panel' : 'Show intelligence panel'}
          >
            {showPanel
              ? <PanelRightClose className="h-3.5 w-3.5" strokeWidth={1.75} />
              : <PanelRightOpen className="h-3.5 w-3.5" strokeWidth={1.75} />}
            <span className="hidden md:inline">Insights</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="More actions"
              className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-aurea-ink-2 transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink md:hidden"
            >
              <MoreVertical className="h-4 w-4" strokeWidth={1.75} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={analyzeConversation}
                disabled={analyzing || !conversation || messages.length < 2}
              >
                {analyzing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />}
                Analyze
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={getFollowUpPlan}
                disabled={generatingFollowUp || !conversation}
              >
                {generatingFollowUp ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Heart className="h-3.5 w-3.5" strokeWidth={1.75} />}
                Smart Follow-Up
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Human-response SLA countdown — renders only while a pending timer runs */}
      {conversation && <SlaCountdown conversationId={conversation.id} />}

      {/* ── Messages ───────────────────────────────────────── */}
      {/* The band is a column flexbox purely so the auto margin below can centre
          the empty-thread placeholder. Real messages top-align: this pane is the
          full viewport height on /leads/[id], so bottom-anchoring a short thread
          (the old `mt-auto`) opened a screen-tall void between the header and the
          first message. Long threads still land on the newest message — the
          scrollRef effect drives the scroll, not the layout. */}
      <div ref={scrollRef} className="flex flex-1 flex-col overflow-y-auto bg-aurea-canvas px-4 py-5 lg:px-6">
        <div
          className={`mx-auto w-full max-w-[720px] space-y-5 ${
            threadIsEmpty ? 'my-auto' : ''
          }`}
        >
          {thread.map((item) =>
            item.type === 'day' ? (
              <div key={item.key} className="flex items-center gap-4 pt-2">
                <div className="h-px flex-1 bg-aurea-border" />
                <span className="aurea-eyebrow">{item.label}</span>
                <div className="h-px flex-1 bg-aurea-border" />
              </div>
            ) : item.type === 'call' ? (
              <CallCard key={item.key} call={item.call} canTrainAi={canTrainAi} />
            ) : (
              <MessageGroup key={item.key} messages={item.messages} lead={lead} timeZone={timeZone} />
            )
          )}

          {threadIsEmpty && (
            <div className="flex flex-col items-center py-16 text-center">
              <MessageSquare className="mb-3 h-7 w-7 text-aurea-ink-3" strokeWidth={1.5} />
              <p className="text-[14px] font-medium text-aurea-ink">No messages yet</p>
              <p className="mt-1 text-[13px] text-aurea-ink-3">Start the conversation below.</p>
            </div>
          )}

          {/* Live call — streams the transcript in as the call happens */}
          <LiveCallPanel live={live} />
        </div>
      </div>

      {/* ── Compose ────────────────────────────────────────── */}
      <div className="border-t border-aurea-border px-4 py-4 lg:px-6">
        <div className="mx-auto w-full max-w-[720px] space-y-3">
          {/* Draft suppressed — the lead needs a human, or the thread is closed.
              We show the reason (and recovery guidance) instead of a draft. */}
          {draftBlock && (
            <div
              className={`flex items-start gap-2 rounded-lg border p-2.5 text-sm ${
                draftBlock.kind === 'escalation'
                  ? 'border-aurea-rose/30 bg-aurea-rose/10'
                  : 'border-aurea-border bg-aurea-surface-2'
              }`}
            >
              <AlertTriangle
                className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${draftBlock.kind === 'escalation' ? 'text-aurea-rose' : 'text-aurea-ink-3'}`}
                strokeWidth={1.75}
              />
              <div className="min-w-0 flex-1">
                <span className={`text-xs font-medium ${draftBlock.kind === 'escalation' ? 'text-aurea-rose' : 'text-aurea-ink-2'}`}>
                  {draftBlock.kind === 'escalation' ? 'AI draft held — needs a human' : 'No draft generated'}
                </span>
                <p className="mt-0.5 text-xs text-aurea-ink-2">{draftBlock.reason}</p>
                {draftBlock.guidance && (
                  <p className="mt-1 text-xs text-aurea-ink-3">
                    <span className="font-medium text-aurea-ink-2">Suggested next step: </span>
                    {draftBlock.guidance}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setDraftBlock(null)}
                  className="mt-1.5 text-xs font-medium text-aurea-ink-3 underline underline-offset-2 hover:text-aurea-ink"
                >
                  Write manually
                </button>
              </div>
            </div>
          )}

          {/* Agent notes (staff-visible reasoning from the AI) */}
          {agentNotes && (
            <div className="flex items-start gap-2 rounded-lg border border-aurea-amber/30 bg-aurea-amber/10 p-2.5 text-sm">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-aurea-amber" strokeWidth={1.75} />
              <div>
                <span className="text-xs font-medium text-aurea-amber">Agent Notes:</span>
                <p className="mt-0.5 text-xs text-aurea-ink-2">{agentNotes}</p>
              </div>
            </div>
          )}

          {/* Sales technique tracking display */}
          {(techniquesUsed.length > 0 || leadAssessment) && (
            <div className="space-y-2 rounded-lg border border-aurea-border bg-aurea-surface-2 p-2.5 text-xs">
              {techniquesUsed.length > 0 && (
                <div>
                  <span className="font-medium text-aurea-ink">Techniques Used:</span>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {techniquesUsed.map((t, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium ${
                          t.effectiveness === 'effective'
                            ? 'border-aurea-primary/20 bg-aurea-primary/10 text-aurea-primary'
                            : t.effectiveness === 'backfired'
                              ? 'border-aurea-rose/20 bg-aurea-rose/10 text-aurea-rose'
                              : 'border-aurea-border bg-aurea-surface text-aurea-ink-3'
                        }`}
                        title={t.context_note}
                      >
                        {t.technique_id.replace(/_/g, ' ').replace(/^[a-z]+\s/, '')}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {leadAssessment && (
                <div className="flex items-center gap-3 text-aurea-ink-2">
                  <span>Engagement: <strong>{leadAssessment.engagement_temperature}/10</strong></span>
                  <span>Resistance: <strong>{leadAssessment.resistance_level}/10</strong></span>
                  <span>Buying Ready: <strong>{leadAssessment.buying_readiness}/10</strong></span>
                  <span>State: <strong>{leadAssessment.emotional_state}</strong></span>
                </div>
              )}
            </div>
          )}

          {/* Message input */}
          {/* Drag this grip up for more room (long emails); double-click to reset. */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Drag to resize the message box"
            title="Drag to resize · double-click to reset"
            onPointerDown={startComposerResize}
            onDoubleClick={resetComposerHeight}
            className="group -mb-1 flex h-4 cursor-row-resize touch-none items-center justify-center"
          >
            <div className="h-1 w-9 rounded-full bg-aurea-border-strong transition-colors group-hover:bg-aurea-ink-3" />
          </div>

          {/* Meta's 24-hour reply window. Advisory only — the send stays enabled,
              because our thread copy can lag Meta's and a false block is worse
              than a rejected send. See src/lib/messaging/social-window.ts. */}
          {socialWindow && socialWindow.status !== 'open' && (
            <div className="flex items-start gap-2 rounded-lg border border-aurea-amber/30 bg-aurea-amber/10 px-3 py-2 text-[12px] leading-relaxed text-aurea-ink-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-aurea-amber" strokeWidth={1.75} />
              <span>
                {socialWindow.status === 'never_opened' ? (
                  <>
                    <strong className="font-medium text-aurea-ink">
                      {lead.first_name || 'This lead'} hasn’t messaged you yet.
                    </strong>{' '}
                    {threadMeta.label} only allows replies within 24 hours of an inbound
                    message, so this send will likely be rejected.
                  </>
                ) : (
                  <>
                    <strong className="font-medium text-aurea-ink">
                      Outside the 24-hour reply window.
                    </strong>{' '}
                    {lead.first_name || 'This lead'} last messaged{' '}
                    {formatDistanceToNow(new Date(socialWindow.lastInboundAt), { addSuffix: true })}.
                    {threadMeta.label} will likely reject this send.
                  </>
                )}{' '}
                {windowFallback
                  ? `Try ${windowFallback.label} instead.`
                  : 'No phone or email on file — add one in the header to follow up.'}
              </span>
            </div>
          )}

          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              sendChannel === 'sms'
                ? `Text ${lead.first_name || 'this lead'}...`
                : sendChannel === 'email'
                  ? `Email ${lead.first_name || 'this lead'}...`
                  : `Reply to ${lead.first_name || 'this lead'} on ${channelMeta(sendChannel).label}...`
            }
            style={{ height: composerHeight }}
            className="resize-none text-[13.5px] [field-sizing:fixed]"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleSend()
              }
            }}
          />

          {/* Toolbar — wraps on phones so channel toggle, AI draft, and Send
              never overflow a 375px composer */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {/* Channel toggle — send this message as a text or an email,
                  right here. No separate window.

                  A social thread shows a fixed badge instead: the reply must go
                  back out on the channel the patient used, so there is nothing
                  to choose. */}
              {socialLocked ? (
                <span
                  className="inline-flex items-center gap-1.5 rounded-lg border border-aurea-border px-2.5 py-1.5 text-[12px] font-medium text-aurea-ink-2"
                  title={`Replies go back to ${threadMeta.label}. DMing the page isn't permission to text or email.`}
                >
                  <ChannelIcon channel={threadMeta.key} className="h-3 w-3" tinted />
                  Reply on {threadMeta.label}
                </span>
              ) : (
                <div className="inline-flex overflow-hidden rounded-lg border border-aurea-border">
                  {(['sms', 'email'] as const).map((ch) => {
                    const active = sendChannel === ch
                    const Icon = ch === 'sms' ? MessageSquare : Mail
                    // Reads the locally-mirrored contact so adding a number in
                    // the header unblocks this toggle without a page refresh.
                    const blocked = ch === 'sms' ? !contact.phone : !contact.email
                    return (
                      <button
                        key={ch}
                        type="button"
                        onClick={() => setSendChannel(ch)}
                        disabled={blocked}
                        title={blocked ? (ch === 'sms' ? 'No phone number — add one in the header' : 'No email address — add one in the header') : `Send as ${ch === 'sms' ? 'text' : 'email'}`}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          active
                            ? 'bg-aurea-ink text-aurea-canvas'
                            : 'text-aurea-ink-3 hover:bg-aurea-surface-2 hover:text-aurea-ink'
                        }`}
                      >
                        <Icon className="h-3 w-3" strokeWidth={1.75} />
                        {ch === 'sms' ? 'Text' : 'Email'}
                      </button>
                    )
                  })}
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={generateAIMessage}
                disabled={generating || !conversation}
                className="gap-1.5"
                title={conversation
                  ? `Auto-selects ${activeAgent === 'closer' ? 'Closer' : 'Setter'} based on lead stage`
                  : 'Send the first message to start the thread, then AI drafts unlock'}
              >
                {generating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Brain className="h-3 w-3 text-aurea-primary" strokeWidth={1.75} />
                )}
                <span className="hidden sm:inline">AI Agent Draft</span>
                <span className="sm:hidden">AI Draft</span>
              </Button>
              {/* Legacy mode selector as fallback */}
              <Select items={AI_MODE_LABELS} value={aiMode} onValueChange={(v) => v && setAiMode(v)}>
                <SelectTrigger className="h-8 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="education">Educate</SelectItem>
                  <SelectItem value="objection_handling">Objections</SelectItem>
                  <SelectItem value="appointment_scheduling">Schedule</SelectItem>
                  <SelectItem value="follow_up">Follow Up</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-3">
              {sendChannel === 'sms' && draft.length > 0 && (
                <span className={`text-[11px] tabular-nums ${draft.length > 320 ? 'text-aurea-amber' : 'text-aurea-ink-3'}`}>
                  {draft.length} · {smsSegments} segment{smsSegments > 1 ? 's' : ''}
                </span>
              )}
              <span className="hidden text-[11px] text-aurea-ink-3 sm:inline">⌘↵ to send</span>
              <Button
                onClick={handleSend}
                disabled={sending || !draft.trim()}
                size="sm"
                className="gap-1.5"
              >
                {sending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
                )}
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
      </div>

      {/* ── Intelligence side panel (collapsible) ──────────── */}
      {showPanel && (
        <aside
          // Phone: the panel can't sit beside the chat column, so it slides over
          // it as a full-screen overlay (the Insights button toggles it shut).
          // Desktop: unchanged resizable sibling. Width goes through a CSS var
          // rather than an inline `width` so the mobile `w-full` isn't
          // overridden by the inline style at every breakpoint.
          className="absolute inset-0 z-20 flex w-full flex-col border-l border-aurea-border bg-aurea-surface lg:relative lg:inset-auto lg:z-auto lg:w-(--panel-w) lg:shrink-0"
          style={{ '--panel-w': `${panelWidth}px` } as React.CSSProperties}
        >
          {/* Drag grip on the left edge — widen/narrow the panel; double-click resets. */}
          <div
            onPointerDown={startPanelResize}
            onDoubleClick={resetPanelWidth}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize intelligence panel"
            title="Drag to resize · double-click to reset"
            // Desktop-only: `touch-none` on a full-height strip swallows swipes,
            // and there's nothing to resize when the panel is a full-screen
            // overlay.
            className="group absolute left-0 top-0 z-20 hidden h-full w-2.5 -translate-x-1/2 cursor-col-resize touch-none lg:block"
          >
            <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-aurea-primary/60" />
          </div>
          <div className="flex items-center justify-between border-b border-aurea-border px-4 py-3">
            <span className="aurea-eyebrow">Lead Intelligence</span>
            <button
              type="button"
              onClick={togglePanel}
              aria-label="Hide panel"
              className="flex h-7 w-7 items-center justify-center rounded-md text-aurea-ink-3 transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink"
            >
              <PanelRightClose className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <LeadSummary
              lead={lead}
              profile={profile}
              timeZone={timeZone}
              stages={stages}
              stageId={stageId}
              stage={stage}
              onStageChange={moveStage}
              movingStage={movingStage}
            />
            <LeadNotesPanel
              leadId={lead.id}
              notes={notes}
              currentUserId={currentUserId}
              timeZone={timeZone}
            />
            {analysisResult || followUpResult ? (
              <InsightsPanel analysisResult={analysisResult} followUpResult={followUpResult} />
            ) : (
              <div className="border-t border-aurea-border px-4 py-8 text-center">
                <Eye className="mx-auto mb-2 h-5 w-5 text-aurea-ink-3" strokeWidth={1.5} />
                <p className="text-[13px] font-medium text-aurea-ink">No analysis yet</p>
                <p className="mx-auto mt-1 max-w-[240px] text-[12px] leading-relaxed text-aurea-ink-3">
                  Analyze scores tone, engagement, HIPAA compliance and coaching for this conversation — and saves the result.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={analyzeConversation}
                  disabled={analyzing || !conversation || messages.length < 2}
                  className="mt-3 gap-1.5"
                >
                  {analyzing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" strokeWidth={1.75} />}
                  Analyze conversation
                </Button>
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  )
}

// ── Lead Summary ────────────────────────────────────────────
// Always-on read of "where things stand": qualification, the AI narrative, the
// patient's current emotional read, and the next best action. Sourced entirely
// from already-persisted rows (patient_profiles + lead), so it costs nothing to
// render and refreshes whenever a new analysis is run.

// The analyst writes next_best_action as prose with an embedded enumeration —
// "... must: (1) apologize; (2) send a working link; (3) offer a time." Pull that
// apart into discrete steps so a rep can scan it, not read it. Falls back to
// plain prose (empty steps) when there's no clear (1)(2)… sequence.
function parseActionSteps(text: string): { intro: string; steps: string[] } {
  const cuts: Array<{ start: number; end: number }> = []
  let expected = 1
  for (const m of text.matchAll(/\(?(\d{1,2})\)\s+/g)) {
    if (Number(m[1]) === expected && m.index != null) {
      cuts.push({ start: m.index, end: m.index + m[0].length })
      expected++
    }
  }
  if (cuts.length < 2) return { intro: text.trim(), steps: [] }
  const intro = text.slice(0, cuts[0].start).trim().replace(/[:;,—–-]\s*$/, '')
  const steps = cuts.map((c, i) => {
    const seg = text.slice(c.end, i + 1 < cuts.length ? cuts[i + 1].start : undefined).trim()
    // Drop the connective tail a list item often ends on (";", "; and", ".").
    return seg.replace(/[;.]\s*(?:and\b)?\s*$/i, '').trim()
  })
  return { intro, steps }
}

function LeadSummary({
  lead,
  profile,
  timeZone,
  stages,
  stageId,
  stage,
  onStageChange,
  movingStage,
}: {
  lead: Lead
  profile: PatientProfile | null
  timeZone: string
  stages: PipelineStage[]
  stageId: string | null
  stage: PipelineStage | null
  onStageChange: (stageId: string) => void
  movingStage: boolean
}) {
  const qualification = lead.ai_qualification || 'unscored'
  const narrative = profile?.ai_summary || lead.ai_summary || null
  const qualTone =
    qualification === 'hot'
      ? 'border-aurea-rose/20 bg-aurea-rose/10 text-aurea-rose'
      : qualification === 'warm'
        ? 'border-aurea-amber/20 bg-aurea-amber/10 text-aurea-amber'
        : 'border-aurea-border bg-aurea-surface-2 text-aurea-ink-2'

  // Where the lead sits in the funnel + how engaged they are. Stage prefers the
  // joined pipeline_stage row; falls back to the raw status when it isn't loaded.
  const stageName = stage?.name || lead.status?.replace(/_/g, ' ') || '—'
  const stageColor = stage?.color || null
  const engagement = Math.round(lead.engagement_score ?? 0)

  // Provenance — "where did this lead come from". Prefer DGS-resolved channel/
  // campaign (leads.campaign_attribution) and fall back to the raw source_type /
  // utm_campaign. Area of interest reuses the same service-line classifier the
  // pipeline, /leads filters, and Slack routing use, so labels agree app-wide.
  const source = channelLabel(lead.campaign_attribution?.channel) || lead.source_type?.replace(/_/g, ' ') || null
  const campaign = formatCampaignAttribution(lead.campaign_attribution) || lead.utm_campaign || null
  const interest =
    lead.dental_condition?.replace(/_/g, ' ') ||
    classifyLeadServiceLines(lead)
      .map((k) => SERVICE_LINES.find((s) => s.key === k)?.label ?? k)
      .join(', ') ||
    null
  const provenance = ([['Source', source], ['Campaign', campaign], ['Interest', interest]] as const).filter(
    ([, v]) => Boolean(v),
  )

  return (
    <CollapsibleSection
      title="Lead Summary"
      className="px-4 py-4"
      contentClassName="mt-3 space-y-3"
      headerAccessory={
        <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold capitalize ${qualTone}`}>
          <Brain className="h-3 w-3" strokeWidth={1.75} />
          {lead.ai_score != null && <span className="font-mono tabular-nums">{lead.ai_score}</span>}
          {qualification}
        </span>
      }
    >
      {/* Vitals: funnel stage · engagement · quality — the fast "who is this" read */}
      <div className="grid grid-cols-3 gap-3">
        <div className="min-w-0 border-l-2 border-aurea-border-strong/60 pl-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-aurea-ink-3">Stage</div>
          {/* Editable in place: reads as plain text until hovered, so the vitals
              row still scans as a summary rather than a form. Falls back to the
              static read when the caller didn't hand down any stages. */}
          {stages.length > 0 ? (
            <StageSelect
              stages={stages}
              value={stageId}
              onChange={onStageChange}
              disabled={movingStage}
              size="sm"
              aria-label="Change pipeline stage"
              className="-ml-1.5 mt-0.5 w-[calc(100%+0.375rem)] border-transparent px-1.5 text-[14px] font-medium text-aurea-ink hover:border-aurea-border hover:bg-aurea-surface-2"
            />
          ) : (
            <div className="mt-1 flex items-center gap-1.5">
              {stageColor && (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: stageColor }} />
              )}
              <span className="truncate text-[14px] font-medium capitalize text-aurea-ink" title={stageName}>
                {stageName}
              </span>
            </div>
          )}
        </div>
        <div className="border-l-2 border-aurea-border-strong/60 pl-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-aurea-ink-3">Engagement</div>
          <div className="mt-1 flex items-baseline gap-0.5">
            <span className="aurea-display text-[18px] tabular-nums text-aurea-ink">{engagement}</span>
            <span className="text-[11px] text-aurea-ink-3">/100</span>
          </div>
        </div>
        <div className="border-l-2 border-aurea-border-strong/60 pl-3">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-aurea-ink-3">Quality</div>
          <div className="mt-1 truncate text-[14px] font-medium capitalize text-aurea-ink" title={qualification}>
            {qualification}
          </div>
        </div>
      </div>

      {/* Provenance — where the lead came from: source · campaign · area of interest */}
      {provenance.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-aurea-border bg-aurea-surface-2/40 px-3 py-2.5">
          {provenance.map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-2 text-[13px]">
              <span className="w-[68px] shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-aurea-ink-3">
                {label}
              </span>
              <span className="min-w-0 truncate font-medium capitalize text-aurea-ink" title={value ?? undefined}>
                {value}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Current emotional read — a fast at-a-glance state, grouped with the vitals */}
      {profile && (profile.emotional_state || profile.personality_type) && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          {profile.emotional_state && (
            <span className="text-aurea-ink-3">
              Feeling{' '}
              <span
                className={`font-semibold text-aurea-ink ${profile.emotional_state.trim().split(/\s+/).length <= 2 ? 'capitalize' : 'first-letter:uppercase'}`}
              >
                {profile.emotional_state}
              </span>
            </span>
          )}
          {profile.personality_type && (
            <span className="inline-flex rounded-md border border-aurea-border bg-aurea-surface-2 px-2 py-0.5 text-[12px] font-medium capitalize text-aurea-ink-2">
              {profile.personality_type}
            </span>
          )}
        </div>
      )}

      {/* The narrative — larger and airier so it reads, not squints */}
      {narrative ? (
        <p className="text-[14px] leading-[1.7] text-aurea-ink-2">{narrative}</p>
      ) : (
        <p className="text-[13px] italic leading-relaxed text-aurea-ink-3">
          No summary yet — run Analyze to build a picture of where this lead stands.
        </p>
      )}

      {/* Next best action — the whole point of "where things stand".
          Turn the AI's "(1)…(2)…" prose into a scannable checklist. */}
      {profile?.next_best_action && (() => {
        const { intro, steps } = parseActionSteps(profile.next_best_action)
        return (
          <div className="rounded-lg border border-aurea-primary/25 bg-aurea-primary/10 px-3.5 py-3">
            <div className="aurea-eyebrow mb-2 flex items-center gap-1.5 !text-[11px] !text-aurea-primary">
              <Zap className="h-3.5 w-3.5" strokeWidth={2} /> Pick Up From Here
            </div>
            {steps.length > 0 ? (
              <>
                {intro && (
                  <p className="mb-2.5 text-[14px] font-medium leading-[1.6] text-aurea-ink">{intro}</p>
                )}
                <ol className="space-y-2">
                  {steps.map((s, i) => (
                    <li key={i} className="flex gap-2.5 text-[14px] leading-[1.55] text-aurea-ink-2">
                      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-aurea-primary/20 text-[11px] font-semibold tabular-nums text-aurea-primary">
                        {i + 1}
                      </span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
              </>
            ) : (
              <p className="text-[14px] leading-[1.65] text-aurea-ink-2">{profile.next_best_action}</p>
            )}
            {profile.recommended_tone && (
              <div className="mt-3 flex items-center gap-1.5 border-t border-aurea-primary/15 pt-2.5 text-[12.5px] font-medium text-aurea-primary">
                <TrendingUp className="h-3.5 w-3.5" strokeWidth={1.75} /> Tone: {profile.recommended_tone}
              </div>
            )}
          </div>
        )
      })()}

      {profile?.last_analyzed_at && (
        <p className="text-[11px] text-aurea-ink-3">
          Updated {zonedDateTimeLabel(new Date(profile.last_analyzed_at), timeZone)}
        </p>
      )}
    </CollapsibleSection>
  )
}

// ── Message group ───────────────────────────────────────────
// One meta line (sender · agent · time) above a tight stack of bubbles.

function MessageGroup({ messages, lead, timeZone }: { messages: Message[]; lead: Lead; timeZone: string }) {
  const first = messages[0]
  const outbound = first.direction === 'outbound'
  const isAI = first.sender_type === 'ai'
  const isEmail = first.channel === 'email'
  const hasAIDraft = messages.some((m) => m.ai_generated)

  const senderLabel = isAI
    ? 'AI'
    : first.sender_name ||
      (first.direction === 'inbound'
        ? `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() || 'Lead'
        : 'You')

  return (
    <div className={`flex flex-col ${outbound ? 'items-end' : 'items-start'}`}>
      {/* Meta line */}
      <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-aurea-ink-3">
        {isAI ? (
          <Bot className="h-3 w-3 text-aurea-primary" strokeWidth={1.75} />
        ) : (
          <User className="h-3 w-3" strokeWidth={1.75} />
        )}
        <span className="font-medium text-aurea-ink-2">{senderLabel}</span>
        {isAI && <AgentMessageLabel agent={agentOf(first)} />}
        {/* Channel marker — an email reads as its own kind of event, not a text */}
        {isEmail && (
          <span className="inline-flex items-center gap-1 rounded border border-aurea-border bg-aurea-surface-2 px-1.5 py-px font-medium text-aurea-ink-3">
            <Mail className="h-2.5 w-2.5" strokeWidth={1.75} /> Email
          </span>
        )}
        {!isAI && hasAIDraft && (
          <Sparkles className="h-3 w-3 text-aurea-primary" strokeWidth={1.75} aria-label="AI-drafted" />
        )}
        <span className="text-aurea-border-strong">·</span>
        <span>{zonedTimeLabel(new Date(first.created_at), timeZone)}</span>
      </div>

      {/* Bubbles — emails get a wider column since they carry subjects + prose */}
      <div className={`flex flex-col gap-1 ${isEmail ? 'max-w-[92%]' : 'max-w-[85%]'} ${outbound ? 'items-end' : 'items-start'}`}>
        {messages.map((msg, i) => {
          const last = i === messages.length - 1
          return (
            <div key={msg.id} className={`flex flex-col ${outbound ? 'items-end' : 'items-start'}`}>
              <div
                title={zonedDateTimeLabel(new Date(msg.created_at), timeZone)}
                className={`rounded-2xl px-3.5 py-2.5 ${
                  outbound
                    ? `bg-aurea-ink text-aurea-canvas ${last ? 'rounded-br-md' : ''}`
                    : `border border-aurea-border bg-aurea-surface text-aurea-ink ${last ? 'rounded-bl-md' : ''}`
                }`}
              >
                {/* Subject reads as the email's headline above the body */}
                {isEmail && msg.subject && (
                  <p
                    className={`mb-1 border-b pb-1 text-[12.5px] font-semibold ${
                      outbound ? 'border-aurea-canvas/20' : 'border-aurea-border'
                    }`}
                  >
                    {msg.subject}
                  </p>
                )}
                {(() => {
                  // Older GHL-mirrored emails still carry the raw unsubscribe
                  // footer in their stored body; strip it at render so historic
                  // rows read cleanly even before the backfill reaches them.
                  const text = isEmail ? stripEmailUnsubscribeFooter(msg.body) : msg.body
                  return text ? (
                    <p className="whitespace-pre-wrap text-[13.5px] leading-[1.55]">{text}</p>
                  ) : null
                })()}
                {/* Attachments — social DMs are often a photo with no text at
                    all (a patient sending a picture of their teeth), so the
                    bubble has to stand on the image alone. */}
                <MessageAttachments message={msg} hasBody={Boolean(msg.body)} />
              </div>
              {msg.status === 'failed' && (
                <span className="mt-1 rounded border border-aurea-rose/30 bg-aurea-rose/10 px-1.5 py-0.5 text-[10px] font-medium text-aurea-rose">
                  Failed to deliver
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Attachments on a message bubble.
 *
 * Images render inline (that's the whole point — a photo of a smile is the
 * message); anything else becomes a labelled link. Files are hosted by GHL and
 * open in a new tab; `noopener` because these are third-party URLs.
 */
function MessageAttachments({ message, hasBody }: { message: Message; hasBody: boolean }) {
  const urls = Array.isArray(message.attachments) ? message.attachments : []
  if (urls.length === 0) return null

  const isImage = (u: string) => /\.(png|jpe?g|gif|webp|heic|bmp)(\?|#|$)/i.test(u)

  return (
    <div className={`flex flex-col gap-1.5 ${hasBody ? 'mt-2' : ''}`}>
      {urls.map((url, i) => {
        const key = `${message.id}:${i}`
        if (!isImage(url)) {
          return (
            <a
              key={key}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[12.5px] underline underline-offset-2 opacity-90 hover:opacity-100"
            >
              <Paperclip className="h-3 w-3" strokeWidth={1.75} />
              Attachment {urls.length > 1 ? i + 1 : ''}
            </a>
          )
        }
        return (
          <a key={key} href={url} target="_blank" rel="noopener noreferrer" className="block">
            {/* Plain <img>: these are arbitrary third-party GHL asset hosts, not
                a configured next/image remote pattern. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt="Attachment"
              loading="lazy"
              className="max-h-64 w-auto max-w-full rounded-lg border border-aurea-border/40 object-contain"
            />
          </a>
        )
      })}
    </div>
  )
}

// ── Insights Panel ──────────────────────────────────────────
// Editorial layout: uniform meter cells for scores, ruled quote block for AI
// prose, all constrained to the same reading column as the thread.

// A single metric as a hairline row: label · meter · number. `invert` marks
// metrics where high is bad (sales pressure, anxiety) so the tone flips.
function MeterRow({ label, value, invert }: { label: string; value: number; invert?: boolean }) {
  const v = Math.max(0, Math.min(10, Number(value) || 0))
  const good = invert ? v <= 3 : v >= 7
  const bad = invert ? v >= 7 : v <= 3
  const tone = bad ? 'bg-aurea-rose/70' : good ? 'bg-aurea-primary/80' : 'bg-aurea-ink-2/50'
  return (
    <div className="flex items-center gap-3 py-[7px]">
      <span className="w-[104px] shrink-0 text-[11px] text-aurea-ink-3">{label}</span>
      <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-aurea-surface-2">
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${v * 10}%` }} />
      </div>
      <span className="aurea-display w-9 shrink-0 text-right text-[15px] tabular-nums text-aurea-ink">
        {value}<span className="text-[10px] text-aurea-ink-3">/10</span>
      </span>
    </div>
  )
}

function FactCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-l border-aurea-border-strong/60 pl-3">
      <div className="text-[10px] uppercase tracking-[0.1em] text-aurea-ink-3">{label}</div>
      <div className="mt-0.5 truncate text-[13px] font-medium capitalize text-aurea-ink" title={value}>
        {value}
      </div>
    </div>
  )
}

// The analyst writes coaching notes as "1. HEADLINE: body 2. NEXT: ..." —
// split that into structured directives; anything else falls back to prose.
const CAPS_KEEP = new Set(['AI', 'SMS', 'MSG', 'HIPAA', 'PHI', 'CRM', 'ASAP'])

function sentenceCase(s: string): string {
  const out = s
    .split(' ')
    .map((w) => (CAPS_KEEP.has(w) ? w : w.toLowerCase()))
    .join(' ')
  return out.charAt(0).toUpperCase() + out.slice(1)
}

function parseCoachingNotes(text: string): { intro: string; items: Array<{ lead: string; body: string }> } {
  // Only treat "N." as an item boundary when N is the next expected number,
  // so numbers inside a sentence ("promised in MSG 15. Add a note") don't split.
  const cuts: Array<{ start: number; end: number }> = []
  let expected = 1
  for (const m of text.matchAll(/(?:^|\s)(\d{1,2})\.\s+(?=[A-Z])/g)) {
    if (Number(m[1]) === expected && m.index != null) {
      cuts.push({ start: m.index, end: m.index + m[0].length })
      expected++
    }
  }
  if (cuts.length < 2) return { intro: text, items: [] }
  const intro = text.slice(0, cuts[0].start).trim()
  const items = cuts.map((c, i) => {
    const seg = text.slice(c.end, i + 1 < cuts.length ? cuts[i + 1].start : undefined).trim()
    const lead = seg.match(/^([A-Z][A-Z0-9 ,'&/-]{2,60}):\s*/)
    return lead ? { lead: sentenceCase(lead[1]), body: seg.slice(lead[0].length) } : { lead: '', body: seg }
  })
  return { intro, items }
}

function CoachingNotes({ text }: { text: string }) {
  const { intro, items } = parseCoachingNotes(text)
  return (
    <div className="border-l-2 border-aurea-gold py-1 pl-3.5">
      <div className="aurea-eyebrow mb-1.5">Coaching Notes</div>
      {intro && <p className="mb-2 text-[12.5px] leading-relaxed text-aurea-ink-2">{intro}</p>}
      {items.length > 0 && (
        <ol className="space-y-2">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2.5 text-[12.5px] leading-relaxed">
              <span className="aurea-display shrink-0 tabular-nums text-aurea-gold">{i + 1}</span>
              <span className="text-aurea-ink-2">
                {it.lead && <span className="font-medium text-aurea-ink">{it.lead}. </span>}
                {it.body}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function PointList({ title, items, tone }: { title: string; items: string[]; tone: 'primary' | 'amber' }) {
  return (
    <div>
      <div className={`aurea-eyebrow mb-1.5 ${tone === 'primary' ? '!text-aurea-primary' : '!text-aurea-amber'}`}>
        {title}
      </div>
      <ul className="space-y-1 text-[12.5px] leading-relaxed text-aurea-ink-2">
        {items.map((p, i) => (
          <li key={i} className="flex gap-2">
            <span className="text-aurea-ink-3">&mdash;</span>
            <span>{p}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="aurea-eyebrow whitespace-nowrap">{children}</span>
      <div className="h-px flex-1 bg-aurea-border" />
    </div>
  )
}

// ── Collapsible section ─────────────────────────────────────
// The same eyebrow + hairline-rule header as SectionHeading, but the whole row is
// a toggle: click to fold the module away. Optional `headerAccessory` renders just
// left of the chevron (e.g. the Lead Summary qualification badge).
function CollapsibleSection({
  title,
  defaultOpen = true,
  headerAccessory,
  className,
  contentClassName,
  children,
}: {
  title: React.ReactNode
  defaultOpen?: boolean
  headerAccessory?: React.ReactNode
  className?: string
  contentClassName?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="group flex w-full items-center gap-3 text-left"
      >
        <span className="aurea-eyebrow whitespace-nowrap">{title}</span>
        <div className="h-px flex-1 bg-aurea-border" />
        {headerAccessory}
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-aurea-ink-3 transition-transform duration-200 group-hover:text-aurea-ink ${open ? '' : '-rotate-90'}`}
          strokeWidth={1.75}
        />
      </button>
      {open && <div className={contentClassName ?? 'mt-3'}>{children}</div>}
    </section>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function InsightsPanel({ analysisResult, followUpResult }: { analysisResult: any; followUpResult: any }) {
  const ca = analysisResult?.conversation_analysis
  const pp = analysisResult?.patient_profile
  const fu = followUpResult?.follow_up

  return (
    <div className="border-t border-aurea-border bg-aurea-surface">
      <div className="w-full space-y-5 px-4 py-4">
        {ca && (
          <CollapsibleSection title="Conversation Analysis" contentClassName="mt-3 space-y-3">
            {/* Metrics as two ruled columns: how the patient is responding vs how staff is performing */}
            <div className="grid gap-x-10 sm:grid-cols-2">
              <div className="divide-y divide-aurea-border/60">
                <div className="pb-1 text-[10px] uppercase tracking-[0.1em] text-aurea-ink-3">Patient</div>
                <MeterRow label="Engagement" value={ca.engagement_score} />
                <MeterRow label="Trust" value={ca.trust_score} />
                <MeterRow label="Emotion" value={ca.emotional_score} />
                <MeterRow label="Urgency" value={ca.urgency_score} />
              </div>
              <div className="divide-y divide-aurea-border/60">
                <div className="pb-1 pt-3 text-[10px] uppercase tracking-[0.1em] text-aurea-ink-3 sm:pt-0">Staff delivery</div>
                <MeterRow label="Empathy" value={ca.empathy_level} />
                <MeterRow label="Rapport" value={ca.rapport_building_score} />
                <MeterRow label="Sales Pressure" value={ca.sales_pressure_level} invert />
                {ca.active_listening_score != null && (
                  <MeterRow label="Listening" value={ca.active_listening_score} />
                )}
              </div>
            </div>

            {/* Tone read — compact facts, only when the analyst returned them */}
            {(ca.patient_tone || ca.staff_tone) && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {ca.patient_tone && <FactCell label="Patient tone" value={String(ca.patient_tone)} />}
                {ca.staff_tone && <FactCell label="Staff tone" value={String(ca.staff_tone)} />}
                {ca.tone_alignment && <FactCell label="Alignment" value={String(ca.tone_alignment)} />}
              </div>
            )}

            {/* HIPAA — show the actual issues, not just a count */}
            {ca.compliance_score != null && (
              <div
                className={`rounded-lg border px-3.5 py-2.5 ${
                  ca.compliance_issues?.length > 0
                    ? 'border-aurea-amber/30 bg-aurea-amber/10'
                    : 'border-aurea-border bg-aurea-canvas'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] font-medium text-aurea-ink-2">
                    <Shield className="h-3 w-3" strokeWidth={1.75} /> HIPAA Compliance
                  </span>
                  <span className={`aurea-display text-[16px] tabular-nums ${ca.compliance_score < 90 ? 'text-aurea-amber' : 'text-aurea-ink'}`}>
                    {ca.compliance_score}<span className="text-[10px] text-aurea-ink-3">%</span>
                  </span>
                </div>
                {ca.compliance_issues?.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {ca.compliance_issues.map((iss: { issue: string; severity: string }, i: number) => (
                      <li key={i} className="flex items-start gap-2 text-[12px] leading-relaxed text-aurea-ink-2">
                        <span
                          className={`mt-0.5 shrink-0 rounded border px-1 py-px text-[9px] font-medium uppercase tracking-[0.08em] ${
                            iss.severity === 'critical' || iss.severity === 'violation'
                              ? 'border-aurea-rose/30 text-aurea-rose'
                              : 'border-aurea-amber/40 text-aurea-amber'
                          }`}
                        >
                          {iss.severity}
                        </span>
                        <span>{iss.issue}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {ca.coaching_notes && <CoachingNotes text={ca.coaching_notes} />}

            {/* Quick scan: what worked vs what to fix */}
            {(ca.things_done_well?.length > 0 || ca.improvement_areas?.length > 0) && (
              <div className="grid gap-4 border-t border-aurea-border/60 pt-3 sm:grid-cols-2">
                {ca.things_done_well?.length > 0 && (
                  <PointList title="Done Well" items={ca.things_done_well} tone="primary" />
                )}
                {ca.improvement_areas?.length > 0 && (
                  <PointList title="Improve" items={ca.improvement_areas} tone="amber" />
                )}
              </div>
            )}
          </CollapsibleSection>
        )}

        {pp && (
          <section className="space-y-2.5">
            <SectionHeading>Patient Psychology</SectionHeading>
            <div className="grid grid-cols-2 gap-3">
              <FactCell label="Personality" value={String(pp.personality_type ?? '—')} />
              <FactCell label="Trust" value={String(pp.trust_level ?? '—').replace(/_/g, ' ')} />
            </div>
            <div className="grid gap-x-10 sm:grid-cols-2">
              <MeterRow label="Anxiety" value={pp.anxiety_level} invert />
              <MeterRow label="Motivation" value={pp.motivation_level} />
            </div>
          </section>
        )}

        {fu && (
          <section className="space-y-2.5">
            <SectionHeading>Tailored Follow-Up Plan</SectionHeading>
            <div className="grid grid-cols-3 gap-3">
              <FactCell label="Channel" value={String(fu.recommended_channel ?? '—')} />
              <FactCell label="Timing" value={String(fu.recommended_timing ?? '—')} />
              <FactCell label="Tone" value={String(fu.recommended_tone ?? '—')} />
            </div>
            {fu.talking_points?.length > 0 && (
              <div className="border-l-2 border-aurea-border-strong py-1 pl-3.5">
                <div className="aurea-eyebrow mb-1">Talking Points</div>
                <ul className="space-y-1 text-[12.5px] leading-relaxed text-aurea-ink-2">
                  {fu.talking_points.map((p: string, i: number) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-aurea-ink-3">&mdash;</span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {fu.closing_strategy && (
              <div className="rounded-lg border border-aurea-gold/20 bg-aurea-gold/10 px-3 py-2.5">
                <div className="aurea-eyebrow mb-0.5 !text-aurea-gold">Closing Strategy</div>
                <p className="text-[12.5px] leading-relaxed text-aurea-ink-2">{fu.closing_strategy}</p>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
