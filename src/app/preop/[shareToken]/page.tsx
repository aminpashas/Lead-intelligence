'use client'

import { useEffect, useState, use } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CheckCircle2, Loader2, ClipboardCheck } from 'lucide-react'

type Payload = {
  form: {
    title: string
    content: { sections: Array<{ title: string; items: string[] }> } | null
    status: string
    acknowledged_at: string | null
    acknowledged_name: string | null
  }
  organization: { name: string; phone: string | null } | null
}

export default function PreopPortalPage({
  params,
}: {
  params: Promise<{ shareToken: string }>
}) {
  const { shareToken } = use(params)
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch(`/api/preop/${shareToken}`)
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          setError(err.error ?? 'This link is not available')
          return
        }
        setData(await res.json())
      } catch {
        setError('Could not load your instructions — please try again')
      } finally {
        setLoading(false)
      }
    })()
  }, [shareToken])

  const acknowledge = async () => {
    if (!name.trim()) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/preop/${shareToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (res.ok && data) {
        setData({
          ...data,
          form: { ...data.form, status: 'acknowledged', acknowledged_at: new Date().toISOString(), acknowledged_name: name.trim() },
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-aurea-ink-3" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        <p className="text-[14px] text-aurea-ink-2">{error ?? 'Not found'}</p>
      </div>
    )
  }

  const acknowledged = !!data.form.acknowledged_at
  const sections = data.form.content?.sections ?? []

  return (
    <div className="mx-auto max-w-2xl px-5 py-10">
      <header className="mb-8 border-b border-aurea-border pb-6">
        <p className="aurea-eyebrow mb-2">{data.organization?.name ?? 'Your Dental Practice'}</p>
        <h1 className="aurea-display text-[32px] text-aurea-ink">{data.form.title}</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-aurea-ink-2">
          Please read these instructions carefully — following them closely is the most
          important thing you can do for a smooth surgery and fast recovery.
        </p>
      </header>

      <div className="space-y-8">
        {sections.map((section) => (
          <section key={section.title}>
            <h2 className="aurea-display mb-3 text-[20px] text-aurea-ink">{section.title}</h2>
            <ul className="space-y-2">
              {section.items.map((item, i) => (
                <li key={i} className="flex gap-2.5 text-[14px] leading-relaxed text-aurea-ink-2">
                  <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-aurea-ink-3" />
                  {item}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="mt-10 rounded-xl border border-aurea-border bg-aurea-surface-2 p-5">
        {acknowledged ? (
          <div className="flex items-center gap-3">
            <CheckCircle2 className="h-6 w-6 shrink-0 text-aurea-primary" strokeWidth={1.75} />
            <div>
              <p className="text-[14px] font-medium text-aurea-ink">Thank you — you&apos;re all set.</p>
              <p className="text-[12px] text-aurea-ink-3">
                Confirmed by {data.form.acknowledged_name} on {new Date(data.form.acknowledged_at!).toLocaleDateString()}.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-aurea-ink-2" strokeWidth={1.75} />
              <p className="text-[14px] font-medium text-aurea-ink">
                Please confirm you&apos;ve read these instructions
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Type your full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button disabled={!name.trim() || submitting} onClick={acknowledge} className="shrink-0">
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                I&apos;ve read these
              </Button>
            </div>
          </div>
        )}
      </div>

      {data.organization?.phone && (
        <p className="mt-6 text-center text-[12px] text-aurea-ink-3">
          Questions? Call us at {data.organization.phone}.
        </p>
      )}
    </div>
  )
}
