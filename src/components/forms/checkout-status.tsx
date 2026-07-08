'use client'

import { useCallback, useEffect, useState } from 'react'

type SubApp = {
  lender_slug: string
  lender_name: string
  requested_amount: number
  status: string
  funded_amount: number
  application_url: string | null
}
type Progress = {
  funded_total: number
  covered: number
  outstanding_total: number
  is_complete: boolean
  status: string
}
type Data = { resume_token: string; treatment_total: number; sub_apps: SubApp[]; progress: Progress }

const money = (n: number) => `$${Math.round(n).toLocaleString()}`

const STATUS: Record<string, { label: string; color: string; bg: string }> = {
  selected:  { label: 'Not started',              color: '#78716c', bg: '#f5f5f4' },
  link_sent: { label: 'Link sent — finish it',    color: '#b45309', bg: '#fffbeb' },
  started:   { label: 'In progress',              color: '#b45309', bg: '#fffbeb' },
  approved:  { label: 'Approved — awaiting funds', color: '#1d4ed8', bg: '#eff6ff' },
  funded:    { label: 'Funded',                    color: '#166534', bg: '#f0fdf4' },
  declined:  { label: 'Not approved',              color: '#b91c1c', bg: '#fef2f2' },
  expired:   { label: 'Expired',                   color: '#b91c1c', bg: '#fef2f2' },
}

export function CheckoutStatus({ token }: { token: string }) {
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/financing/checkout/${token}`)
      if (!res.ok) { setError('This link is invalid or has expired. Please contact the office.'); return }
      setData(await res.json())
    } catch { setError('Could not load your plan. Please try again.') }
    finally { setLoading(false) }
  }, [token])

  useEffect(() => { load() }, [load])

  async function selfReport(lender_slug: string) {
    setBusy(lender_slug)
    try {
      await fetch(`/api/financing/checkout/${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lender_slug, status: 'approved', confirmed_by: 'patient' }),
      })
      await load()
    } finally { setBusy('') }
  }

  if (loading) return <p style={{ textAlign: 'center', color: '#78716c' }}>Loading your plan…</p>
  if (error) return <p style={{ textAlign: 'center', color: '#b91c1c' }}>{error}</p>
  if (!data) return null

  const { treatment_total, sub_apps, progress } = data
  const pct = treatment_total > 0 ? Math.min(100, (progress.covered / treatment_total) * 100) : 0

  return (
    <div>
      <h1 style={{ fontSize: '24px', fontWeight: 800, color: '#1f1a15', marginBottom: '6px' }}>Your financing plan</h1>
      <p style={{ fontSize: '15px', color: '#78716c', marginBottom: '20px', lineHeight: 1.5 }}>
        Complete each lender&apos;s application below. You can come back to this page anytime to pick up where you left off.
      </p>

      {/* Coverage */}
      <div style={{ height: '12px', borderRadius: '99px', background: '#e5e0d8', overflow: 'hidden', marginBottom: '8px' }}>
        <div style={{ height: '100%', borderRadius: '99px', background: progress.is_complete ? '#16a34a' : '#d97706', width: `${pct}%`, transition: 'width .4s' }} />
      </div>
      <p style={{ fontSize: '14px', fontWeight: 700, color: progress.is_complete ? '#166534' : '#b45309', marginBottom: '24px' }}>
        {progress.is_complete
          ? `Fully funded — ${money(progress.funded_total)} of ${money(treatment_total)}`
          : `${money(progress.funded_total)} funded · ${money(progress.outstanding_total)} to go`}
      </p>

      {/* Per-lender */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {sub_apps.map(sa => {
          const s = STATUS[sa.status] ?? STATUS.selected
          const done = sa.status === 'funded' || sa.status === 'declined'
          return (
            <div key={sa.lender_slug} style={{ border: '2px solid #e5e0d8', borderRadius: '14px', padding: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '16px', fontWeight: 700, color: '#1f1a15' }}>{sa.lender_name}</span>
                <span style={{ fontSize: '12px', fontWeight: 700, color: s.color, background: s.bg, padding: '4px 10px', borderRadius: '8px' }}>{s.label}</span>
              </div>
              <p style={{ fontSize: '13px', color: '#78716c', margin: '0 0 12px' }}>
                {money(sa.requested_amount)} requested{sa.funded_amount > 0 && ` · ${money(sa.funded_amount)} funded`}
              </p>
              {!done && (
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  {sa.application_url && (
                    <a href={sa.application_url} target="_blank" rel="noopener noreferrer"
                      style={{ fontSize: '14px', fontWeight: 700, color: '#fff', background: '#d97706', padding: '10px 18px', borderRadius: '10px', textDecoration: 'none' }}>
                      Complete application →
                    </a>
                  )}
                  <button type="button" onClick={() => selfReport(sa.lender_slug)} disabled={busy === sa.lender_slug}
                    style={{ fontSize: '14px', fontWeight: 700, color: '#57534e', background: '#faf8f5', border: '2px solid #e5e0d8', padding: '10px 18px', borderRadius: '10px', cursor: 'pointer' }}>
                    {busy === sa.lender_slug ? 'Saving…' : "I finished this one"}
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <p style={{ fontSize: '12px', color: '#a8a29e', marginTop: '20px', textAlign: 'center', lineHeight: 1.5 }}>
        When you mark a lender complete, our team confirms funding on our end. Questions? Just call the office.
      </p>
    </div>
  )
}
