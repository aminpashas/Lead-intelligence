'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, NotebookPen, Pencil, Trash2, X, Check } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { DEFAULT_PRACTICE_TIMEZONE, zonedDateTimeLabel } from '@/lib/time/zoned'

export type LeadNote = {
  id: string
  created_at: string
  description: string | null
  user_id: string | null
  /** Resolved display name for the author; falls back to "Team member". */
  author_name?: string | null
}

/**
 * Manual team notes for a lead, rendered inside the conversation's intelligence
 * rail. Notes are shared with the whole team; only the author can edit or delete
 * their own (the API enforces this — the UI just hides the controls).
 *
 * Persisted as `lead_activities` rows of type `note_added`, which the lead
 * timeline already renders, so a note written here also lands in the Timeline
 * view without any extra plumbing.
 */
export function LeadNotesPanel({
  leadId,
  notes,
  currentUserId,
  timeZone,
}: {
  leadId: string
  notes: LeadNote[]
  currentUserId: string | null
  timeZone?: string
}) {
  const tz = timeZone || DEFAULT_PRACTICE_TIMEZONE
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [, startTransition] = useTransition()
  const router = useRouter()

  /** Re-fetches the server component so the note list and timeline both update. */
  function refresh() {
    startTransition(() => router.refresh())
  }

  async function addNote() {
    const body = draft.trim()
    if (!body || saving) return
    setSaving(true)
    try {
      const res = await fetch(`/api/leads/${leadId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to save note')
      setDraft('')
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save note')
    } finally {
      setSaving(false)
    }
  }

  async function saveEdit(noteId: string) {
    const body = editDraft.trim()
    if (!body || saving) return
    setSaving(true)
    try {
      const res = await fetch(`/api/leads/${leadId}/notes`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_id: noteId, body }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to update note')
      setEditingId(null)
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update note')
    } finally {
      setSaving(false)
    }
  }

  async function deleteNote(noteId: string) {
    // Deletes are permanent — lead_activities has no soft-delete column. The API
    // records the old text to the audit trail, but the note itself is gone.
    if (!confirm('Delete this note? This cannot be undone.')) return
    setSaving(true)
    try {
      const res = await fetch(`/api/leads/${leadId}/notes`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_id: noteId }),
      })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to delete note')
      refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete note')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="border-t border-aurea-border">
      <div className="flex items-center gap-2 px-4 pb-2 pt-4">
        <NotebookPen className="h-3.5 w-3.5 text-aurea-ink-3" strokeWidth={1.75} />
        <span className="aurea-eyebrow">Notes</span>
        {notes.length > 0 && (
          <span className="rounded-full bg-aurea-surface-2 px-1.5 text-[11px] text-aurea-ink-3">
            {notes.length}
          </span>
        )}
      </div>

      <div className="px-4 pb-3">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note for the team…"
          rows={2}
          maxLength={5000}
          className="resize-none text-[13px]"
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter submits — the textarea keeps plain Enter for newlines.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              void addNote()
            }
          }}
        />
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={addNote} disabled={!draft.trim() || saving} className="gap-1.5">
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            Add note
          </Button>
        </div>
      </div>

      {notes.length === 0 ? (
        <p className="px-4 pb-4 text-[12px] leading-relaxed text-aurea-ink-3">
          No notes yet. Anything you add here is visible to the whole team and shows up in the lead&apos;s timeline.
        </p>
      ) : (
        <ul className="space-y-px pb-2">
          {notes.map((note) => {
            const mine = currentUserId != null && note.user_id === currentUserId
            const editing = editingId === note.id

            return (
              <li key={note.id} className="group px-4 py-2.5 hover:bg-aurea-surface-2/50">
                {editing ? (
                  <div className="space-y-2">
                    <Textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      maxLength={5000}
                      autoFocus
                      className="resize-none text-[13px]"
                    />
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} className="gap-1">
                        <X className="h-3 w-3" strokeWidth={1.75} />
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => saveEdit(note.id)}
                        disabled={!editDraft.trim() || saving}
                        className="gap-1"
                      >
                        <Check className="h-3 w-3" strokeWidth={1.75} />
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-aurea-ink">
                      {note.description}
                    </p>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-aurea-ink-3">
                      <span className="truncate">{note.author_name || 'Team member'}</span>
                      <span aria-hidden>·</span>
                      <time dateTime={note.created_at}>
                        {zonedDateTimeLabel(new Date(note.created_at), tz)}
                      </time>
                      {mine && (
                        <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingId(note.id)
                              setEditDraft(note.description ?? '')
                            }}
                            aria-label="Edit note"
                            className="flex h-6 w-6 items-center justify-center rounded text-aurea-ink-3 hover:bg-aurea-surface-2 hover:text-aurea-ink"
                          >
                            <Pencil className="h-3 w-3" strokeWidth={1.75} />
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteNote(note.id)}
                            aria-label="Delete note"
                            className="flex h-6 w-6 items-center justify-center rounded text-aurea-ink-3 hover:bg-aurea-surface-2 hover:text-red-600"
                          >
                            <Trash2 className="h-3 w-3" strokeWidth={1.75} />
                          </button>
                        </span>
                      )}
                    </div>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
