'use client'

import type { LenderSlug } from '@/lib/financing/types'

type SubmissionStatus = 'pending' | 'submitted' | 'approved' | 'denied' | 'error' | 'timeout' | 'link_sent'

type WaterfallStep = {
  lender_slug: LenderSlug
  waterfall_step: number
  status: SubmissionStatus
  application_url?: string | null
  responded_at?: string | null
}

type WaterfallConfig = {
  lenders: Array<{
    slug: LenderSlug
    priority: number
    integration_type: string
  }>
}

const LENDER_NAMES: Record<LenderSlug, string> = {
  carecredit: 'CareCredit',
  sunbit: 'Sunbit',
  proceed: 'Proceed Finance',
  lendingclub: 'LendingClub',
  cherry: 'Cherry',
  alpheon: 'Alpheon Credit',
  affirm: 'Affirm',
}

// Status semantics: approved→primary (emerald), denied/error→rose,
// submitted/pending/link_sent→amber, timeout→muted
const STATUS_CONFIG: Record<SubmissionStatus, { icon: string; colorClass: string; label: string }> = {
  approved:  { icon: '✓', colorClass: 'text-aurea-primary',  label: 'Approved' },
  denied:    { icon: '✗', colorClass: 'text-aurea-rose',     label: 'Denied' },
  submitted: { icon: '⟳', colorClass: 'text-aurea-amber',    label: 'Pending' },
  pending:   { icon: '⟳', colorClass: 'text-aurea-amber',    label: 'Pending' },
  link_sent: { icon: '↗', colorClass: 'text-aurea-amber',    label: 'Link Sent' },
  error:     { icon: '!', colorClass: 'text-aurea-rose',     label: 'Error' },
  timeout:   { icon: '⏰', colorClass: 'text-aurea-ink-3',   label: 'Timeout' },
}

// Step-indicator background via inline style using Aurea CSS vars so it
// respects dark mode automatically.
const STATUS_BG_VAR: Record<SubmissionStatus, string> = {
  approved:  'var(--aurea-primary)',
  denied:    'var(--aurea-rose)',
  submitted: 'var(--aurea-amber)',
  pending:   'var(--aurea-amber)',
  link_sent: 'var(--aurea-amber)',
  error:     'var(--aurea-rose)',
  timeout:   'var(--aurea-ink-3)',
}

export function FinancingWaterfallTracker({
  waterfallConfig,
  submissions,
  currentStep,
}: {
  waterfallConfig: WaterfallConfig
  submissions: WaterfallStep[]
  currentStep: number
}) {
  const submissionMap = new Map(submissions.map(s => [s.lender_slug, s]))

  return (
    <div className="space-y-2">
      {waterfallConfig.lenders.map((lender, idx) => {
        const submission = submissionMap.get(lender.slug)
        const isActive = idx === currentStep && !submission
        const isFuture = idx > currentStep && !submission
        const status = submission?.status
        const config = status ? STATUS_CONFIG[status] : null

        return (
          <div
            key={lender.slug}
            className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-[13px] ${
              isActive
                ? 'border-aurea-amber/30 bg-aurea-amber/5'
                : isFuture
                ? 'border-aurea-border bg-aurea-surface-2 opacity-50'
                : status === 'approved'
                ? 'border-aurea-primary/20 bg-aurea-primary/5'
                : status === 'denied' || status === 'error'
                ? 'border-aurea-rose/20 bg-aurea-rose/5'
                : 'border-aurea-border bg-aurea-surface'
            }`}
          >
            {/* Step indicator */}
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
              style={{
                background: config
                  ? STATUS_BG_VAR[status!]
                  : isActive
                  ? 'var(--aurea-amber)'
                  : 'var(--aurea-border-strong)',
              }}
            >
              {config ? config.icon : idx + 1}
            </div>

            {/* Lender info */}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-aurea-ink truncate">
                  {LENDER_NAMES[lender.slug]}
                </span>
                <span className="aurea-eyebrow text-aurea-ink-3">
                  {lender.integration_type}
                </span>
              </div>
              {config && (
                <span className={`text-[11px] ${config.colorClass}`}>
                  {config.label}
                  {submission?.responded_at && ` · ${new Date(submission.responded_at).toLocaleTimeString()}`}
                </span>
              )}
              {isActive && (
                <span className="text-[11px] font-medium text-aurea-amber">Processing…</span>
              )}
            </div>

            {/* Link button for link-based lenders */}
            {submission?.application_url && (
              <a
                href={submission.application_url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 text-[12px] font-medium text-aurea-primary hover:underline"
              >
                Open →
              </a>
            )}
          </div>
        )
      })}
    </div>
  )
}
