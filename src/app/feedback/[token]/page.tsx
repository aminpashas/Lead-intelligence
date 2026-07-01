'use client'

import { useState, use } from 'react'

type FeedbackState = 'rate' | 'comment' | 'done' | 'used' | 'error'

export default function FeedbackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params)
  const [state, setState] = useState<FeedbackState>('rate')
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Single submit path: promoters (≥4★) go straight through (immediate + redirect
  // to the Google review); detractors (≤3★) collect a comment first, then submit.
  const submit = async (n: number, finalComment?: string) => {
    if (submitting) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/feedback/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: n, comment: finalComment || undefined }),
      })
      if (!res.ok) {
        setState('error')
        return
      }
      const data = await res.json().catch(() => ({}))
      if (data.alreadyResponded) {
        setState('used')
        return
      }
      if (data.routedToReview && data.reviewUrl) {
        window.location.href = data.reviewUrl
        return
      }
      setState('done')
    } catch {
      setState('error')
    } finally {
      setSubmitting(false)
    }
  }

  const pick = (n: number) => {
    setRating(n)
    if (n >= 4) submit(n) // promoters submit immediately and redirect to the review
    else setState('comment') // detractors leave private feedback first
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-neutral-50">
      <div className="max-w-sm w-full bg-white rounded-2xl shadow-sm p-8 text-center">
        {state === 'rate' && (
          <>
            <h1 className="text-xl font-semibold mb-2">How was your visit?</h1>
            <p className="text-sm text-neutral-500 mb-6">Tap a star to rate your experience.</p>
            <div className="flex justify-center gap-2 text-3xl">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  aria-label={`${n} stars`}
                  onClick={() => pick(n)}
                  disabled={submitting}
                  className="hover:scale-110 transition disabled:opacity-50"
                >
                  {n <= rating ? '★' : '☆'}
                </button>
              ))}
            </div>
          </>
        )}
        {state === 'comment' && (
          <>
            <h1 className="text-xl font-semibold mb-2">Sorry it wasn&rsquo;t perfect.</h1>
            <p className="text-sm text-neutral-500 mb-4">Tell us what we could have done better — this goes straight to the team.</p>
            <textarea
              className="w-full border rounded-lg p-3 text-sm"
              rows={4}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Your feedback"
            />
            <button
              className="mt-4 w-full bg-neutral-900 text-white rounded-lg py-2.5 text-sm disabled:opacity-50"
              onClick={() => submit(rating, comment)}
              disabled={submitting}
            >
              Send feedback
            </button>
          </>
        )}
        {state === 'done' && <h1 className="text-xl font-semibold">Thank you! 🙏</h1>}
        {state === 'used' && <p className="text-sm text-neutral-500">Thanks — we&rsquo;ve already received your feedback.</p>}
        {state === 'error' && <p className="text-sm text-neutral-500">This link is no longer valid.</p>}
      </div>
    </main>
  )
}
