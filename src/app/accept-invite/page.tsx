'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Phase = 'verifying' | 'ready' | 'saving' | 'invalid' | 'done'

function AcceptInviteInner() {
  const params = useSearchParams()
  const router = useRouter()
  const supabase = createClient()

  const [phase, setPhase] = useState<Phase>('verifying')
  const [error, setError] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')

  // On mount, exchange the one-time invite token for a session. Using the
  // token_hash + verifyOtp path (rather than URL-hash detection) is
  // deterministic and works with the SSR cookie client.
  useEffect(() => {
    const tokenHash = params.get('token_hash')
    const type = params.get('type')
    // Provisioning mints a `recovery` link; older `invite` links are also honored.
    if (!tokenHash || (type !== 'recovery' && type !== 'invite')) {
      setPhase('invalid')
      setError('This invitation link is missing or malformed.')
      return
    }

    let cancelled = false
    ;(async () => {
      const { error } = await supabase.auth.verifyOtp({
        type: type as 'recovery' | 'invite',
        token_hash: tokenHash,
      })
      if (cancelled) return
      if (error) {
        setPhase('invalid')
        setError(
          'This invitation link is invalid or has expired. Ask your admin to resend it.'
        )
        return
      }
      setPhase('ready')
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setPhase('saving')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) {
      setError(error.message)
      setPhase('ready')
      return
    }

    setPhase('done')
    // Session is already active from verifyOtp — go straight to the app.
    router.push('/dashboard')
    router.refresh()
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* ── Editorial brand panel ─────────────────────────── */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-aurea-ink px-12 py-10 lg:flex">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(80% 60% at 100% 0%, oklch(0.7 0.14 162 / 0.16) 0%, transparent 60%)',
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-[5px] bg-aurea-primary/15 ring-1 ring-aurea-primary/30">
            <span className="h-1.5 w-1.5 rounded-full bg-aurea-primary" />
          </span>
          <span className="text-[12px] font-semibold uppercase tracking-[0.22em] text-white/70">
            Lead Intelligence
          </span>
        </div>

        <div className="relative max-w-md">
          <p className="mb-4 text-[10.5px] font-semibold uppercase tracking-[0.22em] text-aurea-primary">
            Welcome to the team
          </p>
          <h2 className="aurea-display text-[46px] leading-[1.04] text-white">
            One password away from your pipeline.
          </h2>
          <p className="mt-6 max-w-sm text-[15px] leading-relaxed text-white/55">
            Set your password to activate your account and start turning leads into
            booked consults.
          </p>
        </div>

        <div className="relative border-t border-white/10 pt-6">
          <span className="font-mono text-[11.5px] uppercase tracking-[0.16em] text-white/40">
            AI-Powered Implant Lead CRM
          </span>
        </div>
      </aside>

      {/* ── Form ──────────────────────────────────────────── */}
      <main className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm animate-in fade-in-0 duration-500">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-6 w-6 items-center justify-center rounded-[5px] bg-aurea-primary/10 ring-1 ring-aurea-primary/25">
              <span className="h-1.5 w-1.5 rounded-full bg-aurea-primary" />
            </span>
            <span className="text-[12px] font-semibold uppercase tracking-[0.22em] text-aurea-ink-3">
              Lead Intelligence
            </span>
          </div>

          <div className="mb-8">
            <p className="aurea-eyebrow mb-3">Accept invitation</p>
            <h1 className="aurea-display text-[34px] text-aurea-ink">Set your password</h1>
            <p className="mt-2 text-[14px] text-aurea-ink-2">
              Choose a password to activate your account.
            </p>
          </div>

          {phase === 'verifying' && (
            <p className="text-[14px] text-aurea-ink-2">Verifying your invitation…</p>
          )}

          {phase === 'invalid' && (
            <div className="space-y-4">
              <p className="text-[13px] text-aurea-rose">{error}</p>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => router.push('/login')}
              >
                Go to sign in
              </Button>
            </div>
          )}

          {(phase === 'ready' || phase === 'saving' || phase === 'done') && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-[12px] font-medium text-aurea-ink-2">
                  New password
                </Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm" className="text-[12px] font-medium text-aurea-ink-2">
                  Confirm password
                </Label>
                <Input
                  id="confirm"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>

              {error && <p className="text-[13px] text-aurea-rose">{error}</p>}

              <Button
                type="submit"
                className="w-full"
                disabled={phase === 'saving' || phase === 'done'}
              >
                {phase === 'saving' || phase === 'done'
                  ? 'Activating…'
                  : 'Activate account'}
              </Button>
            </form>
          )}
        </div>
      </main>
    </div>
  )
}

export default function AcceptInvitePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center text-[14px] text-aurea-ink-2">
          Loading…
        </div>
      }
    >
      <AcceptInviteInner />
    </Suspense>
  )
}
