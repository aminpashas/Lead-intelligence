'use client'

import { useCallback, useEffect, useState } from 'react'
import { Sparkles, Loader2, AlertTriangle, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { toast } from 'sonner'

/**
 * "Let the AI do it" — hand a reply-shaped task to the AI.
 *
 * Opening the dialog PREVIEWS: the server generates the reply and returns the
 * exact outbound text with no send and no writes to the patient record. The
 * human reads the literal message going to the patient, then "Send as AI"
 * commits it (the server sends the stored draft, not anything the client can
 * alter) and closes the task as delegated_to_ai.
 *
 * When a gate blocks (medical question, low confidence, quiet hours, opt-out,
 * shadow/assist mode), the AI isn't clear to send — the dialog shows why and
 * offers no Send button; the human works the task themselves.
 */

type PreviewResult =
  | { status: 'ready'; message: string; channel: 'sms' | 'email'; confidence?: number }
  | { status: 'blocked'; reason: string; draft?: string }
  | { status: 'error'; reason: string }

/** Human-readable copy for the blocked reasons the preview can return. */
const BLOCK_COPY: Record<string, string> = {
  medical_question_detected: 'This looks like a specific medical question — it needs a clinician, so the AI won’t answer it.',
  outreach_suppressed: 'Outreach is paused for this practice (shadow mode), so the AI can’t send right now.',
  conversation_ai_mode_assist: 'This conversation is set to “assist” — the AI drafts but won’t send on its own.',
  lead_assist_only_override: 'This lead is set to assist-only — the AI drafts but won’t send on its own.',
  autopilot_disabled: 'AI autopilot is turned off for this practice.',
  conversation_ai_mode_off: 'AI is turned off on this conversation.',
  lead_ai_override_off: 'AI is turned off for this lead.',
  not_delegable: 'This task isn’t something the AI can take over.',
  lead_or_conversation_missing: 'The linked lead or conversation is missing.',
  no_reply_context: 'There’s no inbound message for the AI to reply to.',
  already_answered: 'Someone already replied on this thread.',
}

function blockCopy(reason: string): string {
  return BLOCK_COPY[reason] ?? `The AI can’t send this right now (${reason}).`
}

export function DelegateAiDialog({
  taskId,
  taskTitle,
  patientName,
  onDelegated,
}: {
  taskId: string
  taskTitle: string
  patientName: string | null
  onDelegated: () => void
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [preview, setPreview] = useState<PreviewResult | null>(null)

  const runPreview = useCallback(async () => {
    setLoading(true)
    setPreview(null)
    try {
      const res = await fetch(`/api/tasks/${taskId}/delegate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'preview' }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || !json?.preview) {
        setPreview({ status: 'error', reason: json?.error ?? 'preview_failed' })
      } else {
        setPreview(json.preview as PreviewResult)
      }
    } catch {
      setPreview({ status: 'error', reason: 'preview_failed' })
    } finally {
      setLoading(false)
    }
  }, [taskId])

  // Preview as soon as the dialog opens.
  useEffect(() => {
    if (open) runPreview()
  }, [open, runPreview])

  const onSend = useCallback(async () => {
    setSending(true)
    try {
      const res = await fetch(`/api/tasks/${taskId}/delegate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'commit' }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error(
          json?.error === 'already_answered'
            ? 'Someone already replied on this thread.'
            : json?.error === 'send_blocked'
              ? 'The message was blocked at send (consent, opt-out, or review).'
              : 'Could not send. Try again or handle it yourself.'
        )
        return
      }
      toast.success('AI sent the reply.')
      setOpen(false)
      onDelegated()
    } finally {
      setSending(false)
    }
  }, [taskId, onDelegated])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1 border-violet-500/40 bg-violet-500/10 px-2 text-xs text-violet-700 hover:bg-violet-500/15 dark:text-violet-300"
        onClick={() => setOpen(true)}
      >
        <Sparkles className="h-3 w-3" />
        Let AI do it
      </Button>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Sparkles className="h-4 w-4 text-violet-500" />
            Let the AI handle this
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="text-[13px] text-aurea-ink-2">
            <span className="font-medium text-aurea-ink">{taskTitle}</span>
            {patientName && <span> · {patientName}</span>}
          </div>

          {loading && (
            <div className="flex items-center gap-2 py-6 text-sm text-aurea-ink-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Drafting the reply…
            </div>
          )}

          {!loading && preview?.status === 'ready' && (
            <>
              <div>
                <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-aurea-ink-3">
                  AI will send via {preview.channel === 'email' ? 'Email' : 'SMS'}
                </p>
                <div className="rounded-md border border-aurea-border bg-aurea-surface-2 p-3">
                  <p className="whitespace-pre-wrap text-[13px] text-aurea-ink">{preview.message}</p>
                </div>
              </div>
              <p className="text-[11.5px] text-aurea-ink-3">
                This exact message will be sent to the patient and the task will close as handled by AI.
              </p>
            </>
          )}

          {!loading && preview && preview.status !== 'ready' && (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="text-[12.5px] text-aurea-ink-2">
                {preview.status === 'error'
                  ? 'The AI couldn’t draft a reply just now. Try again in a moment, or handle it yourself.'
                  : blockCopy(preview.reason)}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={sending}>
            Cancel
          </Button>
          {preview?.status === 'ready' && (
            <Button
              size="sm"
              className="gap-1 bg-violet-600 text-white hover:bg-violet-700"
              onClick={onSend}
              disabled={sending}
            >
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Send as AI
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
