'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDistanceToNow } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Brain, Sparkles, AlertTriangle, Target, Loader2, RefreshCw, Send, CalendarClock } from 'lucide-react'
import { toast } from 'sonner'
import type { Lead, PatientProfile, ConversationAnalysis } from '@/types/database'
import type { FollowUpPlan } from '@/lib/ai/patient-psychology'

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-aurea-border px-1.5 py-0.5 text-[11px] capitalize text-aurea-ink-2">
      {children}
    </span>
  )
}

export function LeadIntelligencePanel({
  lead,
  profile,
  analysis,
  analyzableConversationId,
}: {
  lead: Lead
  profile: PatientProfile | null
  analysis: ConversationAnalysis | null
  analyzableConversationId: string | null
}) {
  const [running, setRunning] = useState(false)
  const [planning, setPlanning] = useState(false)
  const [followUp, setFollowUp] = useState<FollowUpPlan | null>(null)
  const [sendingNow, setSendingNow] = useState(false)
  const [enrolling, setEnrolling] = useState(false)
  const router = useRouter()

  async function runAnalysis() {
    if (!analyzableConversationId) return
    setRunning(true)
    try {
      const res = await fetch('/api/ai/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: analyzableConversationId, lead_id: lead.id }),
      })
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: 'Analysis failed' }))
        throw new Error(error || 'Analysis failed')
      }
      toast.success('Intelligence updated')
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setRunning(false)
    }
  }

  async function getFollowUp() {
    setPlanning(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}/follow-up-plan`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to generate follow-up')
      setFollowUp(data.plan as FollowUpPlan)
      toast.success('Follow-up plan ready')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate follow-up')
    } finally {
      setPlanning(false)
    }
  }

  async function sendNow() {
    if (!followUp) return
    const channel = followUp.recommended_channel === 'call' ? 'email' : followUp.recommended_channel
    setSendingNow(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}/follow-up-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          subject: channel === 'email' ? `Following up, ${lead.first_name ?? ''}`.trim() : undefined,
          message: followUp.opening_message,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Send failed')
      if (data.sent === false) throw new Error(data.reason || 'Blocked by a send gate')
      toast.success(`Follow-up sent (${channel})`)
      router.refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setSendingNow(false)
    }
  }

  async function startSequence() {
    setEnrolling(true)
    try {
      const res = await fetch(`/api/leads/${lead.id}/follow-up-enroll`, { method: 'POST' })
      if (!res.ok) throw new Error('Enroll failed')
      toast.success('Enrolled in the follow-up sequence')
    } catch {
      toast.error('Failed to start sequence')
    } finally {
      setEnrolling(false)
    }
  }

  const hasIntel = Boolean(profile || analysis)
  const lastAt = profile?.last_analyzed_at ?? analysis?.analyzed_at ?? null
  const objections = (profile?.objections ?? []).filter((o) => !o.addressed).slice(0, 3)
  const redFlags = (analysis?.red_flags ?? []).slice(0, 3)
  const opportunities = (analysis?.opportunities ?? []).slice(0, 3)

  return (
    <div className="aurea-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-aurea-border px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Brain className="h-[15px] w-[15px] text-aurea-primary" strokeWidth={1.75} />
          <h2 className="aurea-display text-[18px] text-aurea-ink">AI Intelligence</h2>
          {lastAt && (
            <span className="font-mono text-[11px] tabular-nums text-aurea-ink-3">
              · {formatDistanceToNow(new Date(lastAt), { addSuffix: true })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            onClick={getFollowUp}
            disabled={planning || !profile}
            variant="outline"
            size="sm"
            className="gap-1.5"
            title={profile ? 'Draft a tailored follow-up' : 'Run analysis first to build a psychology profile'}
          >
            {planning
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              : <Send className="h-3.5 w-3.5" strokeWidth={1.75} />}
            Follow-up
          </Button>
          <Button
            onClick={runAnalysis}
            disabled={running || !analyzableConversationId}
            variant="outline"
            size="sm"
            className="gap-1.5"
            title={analyzableConversationId ? 'Analyze the latest conversation' : 'Needs a conversation with 2+ messages'}
          >
            {running
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              : <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />}
            {hasIntel ? 'Re-analyze' : 'Run analysis'}
          </Button>
        </div>
      </div>

      {!hasIntel ? (
        <div className="px-5 py-6 text-center text-sm text-aurea-ink-3">
          {analyzableConversationId
            ? 'No analysis yet. Run analysis to summarize the conversation, read the tone, and get a recommended next step.'
            : 'Once this lead has a conversation with a couple of messages, AI can summarize it, read the tone, and recommend a next step.'}
        </div>
      ) : (
        <div className="space-y-4 px-5 py-4">
          {profile?.next_best_action && (
            <div className="rounded-lg border border-aurea-primary/20 bg-aurea-primary/5 px-3 py-2.5">
              <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-aurea-primary">
                <Sparkles className="h-3 w-3" strokeWidth={2} /> Next best action
              </div>
              <p className="text-[13.5px] leading-relaxed text-aurea-ink">{profile.next_best_action}</p>
            </div>
          )}

          {profile?.ai_summary && (
            <div>
              <p className="aurea-eyebrow mb-1">Summary</p>
              <p className="text-[13.5px] leading-relaxed text-aurea-ink-2">{profile.ai_summary}</p>
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            {analysis?.patient_tone && <Chip>Tone: {analysis.patient_tone}</Chip>}
            {profile?.recommended_tone && <Chip>Reply tone: {profile.recommended_tone}</Chip>}
            {typeof analysis?.engagement_score === 'number' && <Chip>Engagement {analysis.engagement_score}/10</Chip>}
            {typeof analysis?.trust_score === 'number' && <Chip>Trust {analysis.trust_score}/10</Chip>}
            {typeof profile?.rapport_score === 'number' && <Chip>Rapport {profile.rapport_score}/10</Chip>}
          </div>

          {objections.length > 0 && (
            <div>
              <p className="aurea-eyebrow mb-1">Open objections</p>
              <ul className="space-y-1">
                {objections.map((o, i) => (
                  <li key={i} className="text-[13px] text-aurea-ink-2">• {o.objection}</li>
                ))}
              </ul>
            </div>
          )}

          {opportunities.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-aurea-emerald">
                <Target className="h-3 w-3" strokeWidth={2} /> Opportunities
              </p>
              <ul className="space-y-1">
                {opportunities.map((o, i) => (
                  <li key={i} className="text-[13px] text-aurea-ink-2">• {o.opportunity}</li>
                ))}
              </ul>
            </div>
          )}

          {redFlags.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-aurea-rose">
                <AlertTriangle className="h-3 w-3" strokeWidth={2} /> Red flags
              </p>
              <ul className="space-y-1">
                {redFlags.map((f, i) => (
                  <li key={i} className="text-[13px] text-aurea-ink-2">• {f.flag}</li>
                ))}
              </ul>
            </div>
          )}

          {analysis?.coaching_notes && (
            <div>
              <p className="aurea-eyebrow mb-1">Coaching</p>
              <p className="text-[13px] leading-relaxed text-aurea-ink-3">{analysis.coaching_notes}</p>
            </div>
          )}

          {followUp && (
            <div className="rounded-lg border border-aurea-border bg-aurea-surface-2/40 px-3 py-2.5">
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-aurea-primary">
                <Send className="h-3 w-3" strokeWidth={2} /> Suggested follow-up · {followUp.recommended_channel} · {followUp.recommended_timing}
              </div>
              <p className="whitespace-pre-wrap rounded border border-aurea-border bg-aurea-surface px-2.5 py-2 text-[13px] text-aurea-ink">
                {followUp.opening_message}
              </p>
              {followUp.talking_points?.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {followUp.talking_points.slice(0, 4).map((p, i) => (
                    <li key={i} className="text-[12.5px] text-aurea-ink-2">• {p}</li>
                  ))}
                </ul>
              )}
              {followUp.closing_strategy && (
                <p className="mt-2 text-[12px] text-aurea-ink-3"><span className="text-aurea-ink-2">Close:</span> {followUp.closing_strategy}</p>
              )}
              <div className="mt-3 flex items-center gap-1.5">
                <Button onClick={sendNow} disabled={sendingNow} size="sm" className="gap-1.5">
                  {sendingNow ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" strokeWidth={1.75} />}
                  Send now
                </Button>
                <Button onClick={startSequence} disabled={enrolling} variant="outline" size="sm" className="gap-1.5">
                  {enrolling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.75} />}
                  Start sequence
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
