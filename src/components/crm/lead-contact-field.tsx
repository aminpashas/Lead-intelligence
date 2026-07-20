'use client'

/**
 * Inline add/edit for a lead's phone or email.
 *
 * Staff regularly learn a lead's phone or email mid-conversation — a Messenger
 * or Instagram lead arrives with neither, then types both into the thread. Until
 * someone can write that onto the lead record, the lead stays unreachable on
 * every other channel: SMS, email, and voice all key off these columns.
 *
 * Renders an explicit "Add phone" / "Add email" affordance when the field is
 * empty. That matters more than it looks — the old UI conditionally rendered the
 * value and showed nothing at all when null, so there was no hint the field
 * existed, let alone that it could be filled in.
 *
 * The PATCH route derives phone_formatted (E.164) and the search hashes; this
 * component only sends the raw string the user typed.
 */

import { useState } from 'react'
import { Loader2, Pencil, Plus, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'

type ContactField = 'phone' | 'email'

const LABELS: Record<ContactField, { noun: string; placeholder: string; inputType: string }> = {
  phone: { noun: 'phone', placeholder: '(555) 123-4567', inputType: 'tel' },
  email: { noun: 'email', placeholder: 'name@example.com', inputType: 'email' },
}

export function LeadContactField({
  leadId,
  field,
  value,
  onSaved,
  className = '',
}: {
  leadId: string
  field: ContactField
  value: string | null | undefined
  /** Called with the persisted value so the parent can update its own lead state. */
  onSaved?: (next: string | null) => void
  className?: string
}) {
  const { noun, placeholder, inputType } = LABELS[field]
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value ?? '')
  const [saving, setSaving] = useState(false)
  // Set when the server reports the number already belongs to another lead.
  // Holding it in state turns the next Save into an explicit "yes, I mean it".
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null)

  function startEditing() {
    setDraft(value ?? '')
    setDuplicateWarning(null)
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setDraft(value ?? '')
    setDuplicateWarning(null)
  }

  async function save(confirmDuplicate = false) {
    const next = draft.trim()
    if (next === (value ?? '')) return cancel()

    setSaving(true)
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          [field]: next,
          ...(confirmDuplicate ? { confirm_duplicate_phone: true } : {}),
        }),
      })
      const payload = await res.json().catch(() => ({}))

      if (res.status === 409 && payload.error === 'duplicate_phone') {
        // Not a failure — a question. Keep the draft so Save can confirm it.
        setDuplicateWarning(payload.message ?? 'Another lead already has this number.')
        return
      }
      if (!res.ok) {
        toast.error(payload.message || payload.error || `Could not save ${noun}`)
        return
      }

      onSaved?.(next || null)
      setEditing(false)
      setDuplicateWarning(null)
      toast.success(next ? `${cap(noun)} saved` : `${cap(noun)} removed`)
    } catch {
      toast.error(`Could not save ${noun} — check your connection`)
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <span className={`inline-flex flex-col gap-1 ${className}`}>
        <span className="inline-flex items-center gap-1">
          <Input
            autoFocus
            type={inputType}
            value={draft}
            placeholder={placeholder}
            disabled={saving}
            onChange={(e) => {
              setDraft(e.target.value)
              // Any edit invalidates a confirmation aimed at the previous value.
              if (duplicateWarning) setDuplicateWarning(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); save(Boolean(duplicateWarning)) }
              if (e.key === 'Escape') { e.preventDefault(); cancel() }
            }}
            className="h-7 w-[190px] text-[12.5px]"
            aria-label={`${cap(noun)} for this lead`}
          />
          <button
            type="button"
            onClick={() => save(Boolean(duplicateWarning))}
            disabled={saving}
            aria-label={duplicateWarning ? `Save ${noun} anyway` : `Save ${noun}`}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-aurea-border text-aurea-ink-3 transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink disabled:opacity-50"
          >
            {saving
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Check className="h-3.5 w-3.5" strokeWidth={2} />}
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={saving}
            aria-label="Cancel"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-aurea-border text-aurea-ink-3 transition-colors hover:bg-aurea-surface-2 hover:text-aurea-ink disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </span>
        {duplicateWarning && (
          <span className="max-w-[280px] text-[11px] leading-snug text-amber-600 dark:text-amber-500">
            {duplicateWarning} Save again to add it anyway.
          </span>
        )}
      </span>
    )
  }

  if (!value) {
    return (
      <button
        type="button"
        onClick={startEditing}
        className={`inline-flex items-center gap-1 rounded text-aurea-ink-3 underline decoration-dotted underline-offset-2 transition-colors hover:text-aurea-ink ${className}`}
      >
        <Plus className="h-3 w-3" strokeWidth={2} />
        Add {noun}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={startEditing}
      title={`Edit ${noun}`}
      // Without this the button's accessible name is just the bare value, so a
      // screen reader announces "+15624465110" with no hint it can be changed.
      aria-label={`Edit ${noun}: ${value}`}
      className={`group inline-flex items-center gap-1 rounded transition-colors hover:text-aurea-ink ${className}`}
    >
      <span className={field === 'phone' ? 'font-mono' : 'truncate'}>{value}</span>
      <Pencil
        className="h-2.5 w-2.5 opacity-0 transition-opacity group-hover:opacity-60"
        strokeWidth={2}
      />
    </button>
  )
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
