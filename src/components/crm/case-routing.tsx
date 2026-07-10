'use client'

/**
 * Cross-app routing UI for a clinical case — the two hand-off surfaces that make
 * the CRM's Clinical Cases a *routing hub* rather than a siloed board:
 *   • Lab pill     → Smile Design Lab (live status, deep-links to SDL doctor view)
 *   • Surgery pill → Dion Clinical (hand-off receipt → scheduled → complete)
 *
 * Shared by the board card (compact) and the case-detail Routing section.
 * Derivation lives in src/lib/cases/routing.ts so both render one truth.
 */
import { useState } from 'react'
import { FlaskConical, Stethoscope, ExternalLink, RefreshCw, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ClinicalCase } from '@/types/database'
import {
  deriveLabRouting,
  deriveSurgeryRouting,
  type LabRoutingState,
  type SurgeryRoutingState,
} from '@/lib/cases/routing'

// Tone per state — muted (idle), amber (in-flight), primary (advanced), done (delivered/complete), rose (issue).
const LAB_TONE: Record<LabRoutingState, string> = {
  not_sent:      'border-aurea-border bg-aurea-surface-2 text-aurea-ink-3',
  submitted:     'border-aurea-amber/20 bg-aurea-amber/10 text-aurea-amber',
  in_production: 'border-aurea-amber/20 bg-aurea-amber/10 text-aurea-amber',
  shipped:       'border-aurea-primary/20 bg-aurea-primary/10 text-aurea-primary',
  delivered:     'border-aurea-primary/20 bg-aurea-primary/10 text-aurea-primary',
  issue:         'border-aurea-rose/20 bg-aurea-rose/10 text-aurea-rose',
}

const SURGERY_TONE: Record<SurgeryRoutingState, string> = {
  not_routed: 'border-aurea-border bg-aurea-surface-2 text-aurea-ink-3',
  handed_off: 'border-aurea-amber/20 bg-aurea-amber/10 text-aurea-amber',
  scheduled:  'border-aurea-primary/20 bg-aurea-primary/10 text-aurea-primary',
  completed:  'border-aurea-primary/20 bg-aurea-primary/10 text-aurea-primary',
}

function fmtDate(d: string | null): string | null {
  if (!d) return null
  const parsed = new Date(`${d}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Compact routing pills for a card. Renders nothing until the case has actually
 * reached a hand-off (avoids noise on early-funnel cards).
 */
export function RoutingPills({
  caseData,
  sdlWebBase,
  className,
}: {
  caseData: ClinicalCase
  sdlWebBase?: string | null
  className?: string
}) {
  const lab = deriveLabRouting(caseData, sdlWebBase)
  const surgery = deriveSurgeryRouting(caseData)

  if (!lab.active && !surgery.active) return null

  const surgeryDate = fmtDate(surgery.date)

  return (
    <div className={cn('mt-2 flex flex-wrap items-center gap-1.5 border-t border-aurea-border pt-2', className)}>
      {lab.active && (
        <RoutingPill
          icon={FlaskConical}
          tone={LAB_TONE[lab.state]}
          label={lab.label}
          sub={lab.externalNumber}
          href={lab.deepLink}
        />
      )}
      {surgery.active && (
        <RoutingPill
          icon={Stethoscope}
          tone={SURGERY_TONE[surgery.state]}
          label={surgery.state === 'scheduled' && surgeryDate ? `Surgery ${surgeryDate}` : surgery.label}
        />
      )}
    </div>
  )
}

function relTime(iso: string | null | undefined): string | null {
  if (!iso) return null
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff)) return null
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/**
 * Full routing surface for the case-detail page: a Lab tile (deep-links to SDL)
 * and a Surgery tile with an on-demand "Sync from Dion Clinical" read-back.
 * Renders only once the case has reached routing (a closing exists).
 */
export function RoutingSection({
  caseId,
  caseData,
  sdlWebBase,
  onSynced,
}: {
  caseId: string
  caseData: ClinicalCase
  sdlWebBase?: string | null
  onSynced?: () => void
}) {
  const [syncing, setSyncing] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const lab = deriveLabRouting(caseData, sdlWebBase)
  const surgery = deriveSurgeryRouting(caseData)
  const closing = caseData.closing ?? null

  // Nothing to route until the case is in closing.
  if (!closing && !lab.active && !surgery.active) return null

  const surgeryDate = fmtDate(surgery.date)
  const syncedAt = relTime(closing?.dion_synced_at)

  const sync = async () => {
    setSyncing(true)
    setNote(null)
    try {
      const res = await fetch(`/api/cases/${caseId}/dion-sync`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (data.outcome === 'skipped') setNote('Dion Clinical is not connected for this practice.')
      else if (data.outcome === 'error') setNote('Could not reach Dion Clinical — try again.')
      onSynced?.()
    } catch {
      setNote('Sync failed — try again.')
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="aurea-card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-aurea-border px-5 py-4">
        <ExternalLink className="h-[17px] w-[17px] text-aurea-ink-3" strokeWidth={1.75} />
        <h2 className="aurea-display text-[18px] text-aurea-ink">Routing</h2>
      </div>
      <div className="grid gap-px bg-aurea-border sm:grid-cols-2">
        {/* Lab → Smile Design Lab */}
        <div className="bg-aurea-surface p-5">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
            <p className="aurea-eyebrow">Lab · Smile Design Lab</p>
          </div>
          <p className={cn('mt-2 text-[15px] font-medium', lab.active ? 'text-aurea-ink' : 'text-aurea-ink-3')}>
            {lab.label}
          </p>
          {lab.externalNumber && (
            <p className="mt-0.5 font-mono text-[11px] text-aurea-ink-3">{lab.externalNumber}</p>
          )}
          {lab.deepLink ? (
            <a
              href={lab.deepLink}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-medium text-aurea-primary hover:underline"
            >
              Open in Smile Design Lab <ExternalLink className="h-3 w-3" strokeWidth={1.75} />
            </a>
          ) : (
            <p className="mt-3 text-[12px] text-aurea-ink-3">
              {lab.active ? 'Deep link unavailable' : 'Records not sent to the lab yet.'}
            </p>
          )}
        </div>

        {/* Surgery → Dion Clinical */}
        <div className="bg-aurea-surface p-5">
          <div className="flex items-center gap-2">
            <Stethoscope className="h-4 w-4 text-aurea-ink-3" strokeWidth={1.75} />
            <p className="aurea-eyebrow">Surgery · Dion Clinical</p>
          </div>
          <p className={cn('mt-2 text-[15px] font-medium', surgery.active ? 'text-aurea-ink' : 'text-aurea-ink-3')}>
            {surgery.state === 'scheduled' && surgeryDate ? `Surgery ${surgeryDate}` : surgery.label}
          </p>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={sync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded-md border border-aurea-border px-2.5 py-1 text-[12px] font-medium text-aurea-ink-2 transition-colors hover:bg-aurea-surface-2 disabled:opacity-60"
            >
              {syncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
              Sync from Dion Clinical
            </button>
            {syncedAt && <span className="text-[11px] text-aurea-ink-3">Synced {syncedAt}</span>}
          </div>
          {note && <p className="mt-2 text-[11.5px] text-aurea-ink-3">{note}</p>}
        </div>
      </div>
    </div>
  )
}

function RoutingPill({
  icon: Icon,
  tone,
  label,
  sub,
  href,
}: {
  icon: React.ElementType
  tone: string
  label: string
  sub?: string | null
  href?: string | null
}) {
  const inner = (
    <>
      <Icon className="h-2.5 w-2.5 shrink-0" strokeWidth={1.75} />
      <span>{label}</span>
      {sub && <span className="font-mono opacity-70">· {sub}</span>}
      {href && <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-60" strokeWidth={1.75} />}
    </>
  )
  const cls = cn(
    'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium',
    tone,
    href && 'transition-opacity hover:opacity-80'
  )
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={cls}
        onClick={(e) => e.stopPropagation()}
        title="Open in Smile Design Lab"
      >
        {inner}
      </a>
    )
  }
  return <span className={cls}>{inner}</span>
}
