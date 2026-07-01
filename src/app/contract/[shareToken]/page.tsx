'use client'

import { useEffect, useRef, useState, use } from 'react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react'
import type { RenderedContractSection } from '@/types/database'

type ContractData = {
  id: string
  status: string
  generated_content: RenderedContractSection[]
  contract_amount: number | null
  deposit_amount: number | null
  financing_type: string | null
  financing_monthly_payment: number | null
  signed_at: string | null
  share_token_expires_at: string | null
}

type Payload = {
  contract: ContractData
  organization: { name: string; logo_url: string | null; phone: string | null; email: string | null } | null
  case: { case_number: string; patient_first_name: string } | null
  download_url: string | null
}

function formatCurrency(n: number | null): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n)
}

export default function PatientContractSigningPage({
  params,
}: {
  params: Promise<{ shareToken: string }>
}) {
  const { shareToken } = use(params)
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [consents, setConsents] = useState<Record<string, boolean>>({})
  const [typedName, setTypedName] = useState('')
  const [signatureMode, setSignatureMode] = useState<'drawn' | 'typed'>('drawn')
  const [drawDataUrl, setDrawDataUrl] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const drawingRef = useRef(false)

  const refetch = async () => {
    try {
      const res = await fetch(`/api/contracts/patient/${shareToken}`, { cache: 'no-store' })
      if (res.status === 410) {
        setError('This link has expired. Please contact the practice.')
        return
      }
      if (!res.ok) {
        setError('This link is invalid or has expired.')
        return
      }
      const json = (await res.json()) as Payload
      setData(json)
    } catch {
      setError('Failed to load your agreement.')
    }
  }

  useEffect(() => {
    void (async () => {
      await refetch()
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareToken])

  // Poll after signing until status=executed so we can show the download link
  useEffect(() => {
    if (data?.contract.status !== 'signed') return
    const interval = setInterval(refetch, 3000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.contract.status])

  const requiredConsents = (data?.contract.generated_content ?? [])
    .filter((s) => s.kind === 'consent' && s.consent_key)
    .map((s) => ({ section_id: s.section_id, consent_key: s.consent_key! }))

  const allConsentsChecked = requiredConsents.every((c) => consents[c.consent_key])

  const canSubmit =
    allConsentsChecked &&
    ((signatureMode === 'drawn' && !!drawDataUrl) ||
      (signatureMode === 'typed' && typedName.trim().length >= 2))

  const clearCanvas = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    setDrawDataUrl(null)
  }

  const canvasPos = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    let x = 0, y = 0
    if ('touches' in e) {
      x = e.touches[0].clientX - rect.left
      y = e.touches[0].clientY - rect.top
    } else {
      x = (e as React.MouseEvent).clientX - rect.left
      y = (e as React.MouseEvent).clientY - rect.top
    }
    return { x: (x / rect.width) * canvas.width, y: (y / rect.height) * canvas.height }
  }

  const startDraw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    drawingRef.current = true
    const pos = canvasPos(e)
    const ctx = canvasRef.current!.getContext('2d')!
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.strokeStyle = '#111827'
    ctx.beginPath()
    ctx.moveTo(pos.x, pos.y)
  }
  const moveDraw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return
    const pos = canvasPos(e)
    const ctx = canvasRef.current!.getContext('2d')!
    ctx.lineTo(pos.x, pos.y)
    ctx.stroke()
  }
  const endDraw = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    setDrawDataUrl(canvasRef.current!.toDataURL('image/png'))
  }

  const submit = async () => {
    if (!data) return
    setSubmitting(true)
    try {
      const consentsAgreed = requiredConsents
        .filter((c) => consents[c.consent_key])
        .map((c) => ({ section_id: c.section_id, consent_key: c.consent_key }))
      const body = {
        signer_name: typedName.trim() || (data.case?.patient_first_name ?? ''),
        signature_type: signatureMode,
        signature_data_url: signatureMode === 'drawn' ? drawDataUrl : null,
        consents_agreed: consentsAgreed,
      }
      const res = await fetch(`/api/contracts/patient/${shareToken}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        setError(err?.error ?? 'Could not submit signature. Please try again.')
        return
      }
      await refetch()
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 animate-in fade-in-0 duration-500">
        <Loader2 className="h-6 w-6 animate-spin text-aurea-ink-3" strokeWidth={1.75} />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center p-6 py-24 animate-in fade-in-0 duration-500">
        <div className="aurea-card max-w-md w-full overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[20px] text-aurea-ink">Unable to load agreement</h2>
          </div>
          <div className="px-5 py-4 text-[14px] text-aurea-ink-2">
            {error ?? 'Please contact the practice for a fresh link.'}
          </div>
        </div>
      </div>
    )
  }

  const { contract, organization } = data

  if (contract.status === 'executed' || contract.status === 'signed') {
    return (
      <div className="py-10 px-4 animate-in fade-in-0 duration-500">
        <div className="max-w-2xl mx-auto">
          <div className="aurea-card overflow-hidden">
            <div className="flex items-center gap-3 border-b border-aurea-border px-5 py-4">
              <CheckCircle2 className="h-[18px] w-[18px] text-aurea-primary shrink-0" strokeWidth={1.75} />
              <h2 className="aurea-display text-[20px] text-aurea-ink">
                {contract.status === 'executed' ? 'Your agreement is signed' : 'Thanks — we received your signature'}
              </h2>
            </div>
            <div className="px-5 py-4 space-y-4 text-[14px] text-aurea-ink-2">
              <p>
                {contract.status === 'executed'
                  ? `Your fully-executed agreement with ${organization?.name ?? 'your practice'} is ready to download.`
                  : 'We are finalizing your signed PDF. This page will refresh automatically.'}
              </p>
              {data.download_url && (
                <a
                  href={data.download_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center rounded-lg bg-aurea-ink text-white px-4 py-2 text-[13px] font-medium hover:bg-aurea-ink/85 transition-colors"
                >
                  Download signed agreement (PDF)
                </a>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="py-8 px-4 animate-in fade-in-0 duration-500">
      <div className="max-w-3xl mx-auto space-y-5">
        {/* Header card */}
        <div className="aurea-card overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-aurea-border">
            <div>
              <p className="aurea-eyebrow text-aurea-ink-3 mb-1">{organization?.name}</p>
              <h1 className="aurea-display text-[24px] text-aurea-ink">Treatment Services Agreement</h1>
            </div>
            <ShieldCheck className="h-[22px] w-[22px] text-aurea-primary shrink-0" strokeWidth={1.75} />
          </div>
          <div className="px-5 py-4 text-[14px] text-aurea-ink-2">
            Please review the sections below, check each consent, and sign electronically at the
            bottom of this page.
          </div>
        </div>

        {(contract.generated_content ?? []).map((section) => (
          <div key={section.section_id} className="aurea-card overflow-hidden">
            <div className="border-b border-aurea-border px-5 py-4">
              <h2 className="aurea-display text-[18px] text-aurea-ink">{section.title}</h2>
            </div>
            <div className="px-5 py-4">
              {section.kind === 'data_table' ? (
                <div className="overflow-x-auto">
                  <div
                    className="prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: section.rendered_html }}
                  />
                </div>
              ) : section.kind === 'signature' ? (
                <p className="text-[14px] text-aurea-ink-2 whitespace-pre-wrap">{section.rendered_text}</p>
              ) : (
                <div
                  className="prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: section.rendered_html }}
                />
              )}
              {section.kind === 'consent' && section.consent_key && (
                <>
                  <Separator className="my-4" />
                  <label className="flex items-start gap-3 text-[14px] cursor-pointer text-aurea-ink-2">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4 rounded border-aurea-border"
                      checked={!!consents[section.consent_key]}
                      onChange={(e) =>
                        setConsents((prev) => ({ ...prev, [section.consent_key!]: e.target.checked }))
                      }
                    />
                    <span>I have read and agree to the {section.title}.</span>
                  </label>
                </>
              )}
            </div>
          </div>
        ))}

        {/* Financial summary */}
        <div className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[18px] text-aurea-ink">Summary</h2>
          </div>
          <div className="px-5 py-4 space-y-2 text-[14px] text-aurea-ink-2">
            <div className="flex items-center justify-between">
              <span>Total estimated cost</span>
              <strong className="font-mono tabular-nums text-aurea-ink">{formatCurrency(contract.contract_amount)}</strong>
            </div>
            <div className="flex items-center justify-between">
              <span>Non-refundable deposit at signing</span>
              <strong className="font-mono tabular-nums text-aurea-ink">{formatCurrency(contract.deposit_amount)}</strong>
            </div>
            {contract.financing_monthly_payment != null && (contract.financing_type === 'loan' || contract.financing_type === 'in_house') && (
              <div className="flex items-center justify-between">
                <span>Estimated monthly payment</span>
                <strong className="font-mono tabular-nums text-aurea-ink">{formatCurrency(contract.financing_monthly_payment)}</strong>
              </div>
            )}
          </div>
        </div>

        {/* Signature */}
        <div className="aurea-card overflow-hidden">
          <div className="border-b border-aurea-border px-5 py-4">
            <h2 className="aurea-display text-[18px] text-aurea-ink">Sign this agreement</h2>
          </div>
          <div className="px-5 py-4 space-y-4">
            {!allConsentsChecked && (
              <div className="text-[13px] text-aurea-amber bg-aurea-amber/10 border border-aurea-amber/30 rounded-lg p-3">
                Please acknowledge each consent above before signing.
              </div>
            )}
            <div className="flex gap-2">
              <Button
                variant={signatureMode === 'drawn' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSignatureMode('drawn')}
              >
                Draw signature
              </Button>
              <Button
                variant={signatureMode === 'typed' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSignatureMode('typed')}
              >
                Type signature
              </Button>
            </div>

            <label className="block text-[13px]">
              <span className="block text-aurea-ink-2 mb-1">Your full legal name</span>
              <input
                type="text"
                className="w-full border border-aurea-border rounded px-3 py-2 text-[14px] bg-aurea-surface text-aurea-ink placeholder:text-aurea-ink-3 focus:outline-none focus:border-aurea-border-strong"
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                placeholder="e.g. Jane A. Doe"
              />
            </label>

            {signatureMode === 'drawn' ? (
              <div>
                <div className="text-[12px] text-aurea-ink-3 mb-1">Sign in the box below:</div>
                <canvas
                  ref={canvasRef}
                  width={600}
                  height={160}
                  className="w-full border border-aurea-border rounded bg-aurea-surface touch-none"
                  onMouseDown={startDraw}
                  onMouseMove={moveDraw}
                  onMouseUp={endDraw}
                  onMouseLeave={endDraw}
                  onTouchStart={startDraw}
                  onTouchMove={moveDraw}
                  onTouchEnd={endDraw}
                />
                <div className="flex justify-end mt-1">
                  <Button type="button" size="sm" variant="ghost" onClick={clearCanvas}>
                    Clear
                  </Button>
                </div>
              </div>
            ) : (
              <div
                className="p-4 border border-aurea-border rounded bg-aurea-surface"
                style={{ fontFamily: 'Caveat, "Dancing Script", cursive', fontSize: 32 }}
              >
                {typedName || <span className="text-aurea-ink-3">Your typed signature will appear here</span>}
              </div>
            )}

            <Button onClick={submit} disabled={!canSubmit || submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" strokeWidth={1.75} />
                  Submitting…
                </>
              ) : (
                'Sign & submit'
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
