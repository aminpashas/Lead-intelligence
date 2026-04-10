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

const STATUS_CONFIG: Record<SubmissionStatus, { icon: string; color: string; label: string }> = {
  approved: { icon: '✓', color: '#16a34a', label: 'Approved' },
  denied: { icon: '✗', color: '#dc2626', label: 'Denied' },
  submitted: { icon: '⟳', color: '#d97706', label: 'Pending' },
  pending: { icon: '⟳', color: '#d97706', label: 'Pending' },
  link_sent: { icon: '🔗', color: '#2563eb', label: 'Link Sent' },
  error: { icon: '!', color: '#dc2626', label: 'Error' },
  timeout: { icon: '⏰', color: '#78716c', label: 'Timeout' },
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
            className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
              isActive ? 'border-amber-400 bg-amber-50' :
              isFuture ? 'border-muted bg-muted/30 opacity-50' :
              status === 'approved' ? 'border-green-300 bg-green-50' :
              status === 'denied' || status === 'error' ? 'border-red-200 bg-red-50/50' :
              'border-border'
            }`}
          >
            {/* Step indicator */}
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold"
              style={{
                background: config ? config.color : isActive ? '#d97706' : '#e5e0d8',
                color: '#fff',
              }}
            >
              {config ? config.icon : idx + 1}
            </div>

            {/* Lender info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold truncate">{LENDER_NAMES[lender.slug]}</span>
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {lender.integration_type}
                </span>
              </div>
              {config && (
                <span className="text-xs" style={{ color: config.color }}>
                  {config.label}
                  {submission?.responded_at && ` · ${new Date(submission.responded_at).toLocaleTimeString()}`}
                </span>
              )}
              {isActive && <span className="text-xs text-amber-600 font-medium">Processing...</span>}
            </div>

            {/* Link button for link-based lenders */}
            {submission?.application_url && (
              <a
                href={submission.application_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-blue-600 hover:underline shrink-0"
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
