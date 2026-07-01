'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function SignupPage() {
  const [fullName, setFullName] = useState('')
  const [practiceName, setPracticeName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  async function handleGoogleSignup() {
    setLoading(true)
    setError(null)

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    })

    if (error) {
      setError(error.message)
      setLoading(false)
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    // 1. Create auth user
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          practice_name: practiceName,
        },
      },
    })

    if (authError) {
      setError(authError.message)
      setLoading(false)
      return
    }

    if (!authData.user) {
      setError('Failed to create account')
      setLoading(false)
      return
    }

    // Organization + user profile are created automatically via
    // the on_auth_user_created trigger on auth.users.
    // The trigger reads full_name and practice_name from raw_user_meta_data.

    // If email confirmation is enabled, show a message instead of redirecting
    if (!authData.session) {
      setError(null)
      setLoading(false)
      alert('Check your email to confirm your account, then sign in.')
      router.push('/login')
      return
    }

    router.push('/dashboard')
    router.refresh()
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* ── Editorial brand panel ─────────────────────────── */}
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-aurea-ink px-12 py-10 lg:flex">
        <div
          className="pointer-events-none absolute inset-0"
          style={{ backgroundImage: 'radial-gradient(80% 60% at 100% 0%, oklch(0.7 0.14 162 / 0.16) 0%, transparent 60%)' }}
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
            Set up in minutes
          </p>
          <h2 className="aurea-display text-[46px] leading-[1.04] text-white">
            Give your practice an AI growth engine.
          </h2>
          <p className="mt-6 max-w-sm text-[15px] leading-relaxed text-white/55">
            Connect your leads and let the platform score, message, and reactivate them
            automatically — one calm command center for the whole funnel.
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
          {/* Mobile wordmark (brand panel is desktop-only) */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-6 w-6 items-center justify-center rounded-[5px] bg-aurea-primary/10 ring-1 ring-aurea-primary/25">
              <span className="h-1.5 w-1.5 rounded-full bg-aurea-primary" />
            </span>
            <span className="text-[12px] font-semibold uppercase tracking-[0.22em] text-aurea-ink-3">
              Lead Intelligence
            </span>
          </div>

          <div className="mb-8">
            <p className="aurea-eyebrow mb-3">Get started</p>
            <h1 className="aurea-display text-[34px] text-aurea-ink">Create your account</h1>
            <p className="mt-2 text-[14px] text-aurea-ink-2">
              Spin up your practice workspace.
            </p>
          </div>

          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={handleGoogleSignup}
            disabled={loading}
          >
            <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </Button>

          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-aurea-border" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-aurea-canvas px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-aurea-ink-3">
                Or continue with email
              </span>
            </div>
          </div>

          <form onSubmit={handleSignup} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="practiceName" className="text-[12px] font-medium text-aurea-ink-2">Practice Name</Label>
              <Input
                id="practiceName"
                placeholder="Smile Dental Implant Center"
                value={practiceName}
                onChange={(e) => setPracticeName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fullName" className="text-[12px] font-medium text-aurea-ink-2">Your Name</Label>
              <Input
                id="fullName"
                placeholder="Dr. John Smith"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-[12px] font-medium text-aurea-ink-2">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@practice.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-[12px] font-medium text-aurea-ink-2">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Minimum 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
            </div>

            {error && (
              <p className="text-[13px] text-aurea-rose">{error}</p>
            )}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Creating account…' : 'Create Account'}
            </Button>
          </form>

          <p className="mt-8 text-center text-[13px] text-aurea-ink-3">
            Already have an account?{' '}
            <Link href="/login" className="font-medium text-aurea-primary underline-offset-4 hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </main>
    </div>
  )
}
