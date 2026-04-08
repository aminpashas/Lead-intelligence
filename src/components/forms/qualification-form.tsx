'use client'

import { useState, useCallback } from 'react'
import { cn } from '@/lib/utils'

// =============================================
// TYPES
// =============================================
type FormData = {
  dental_condition: string
  urgency: string
  dental_condition_details: string
  has_dentures: boolean | null
  financing_interest: string
  has_dental_insurance: boolean | null
  insurance_provider: string
  budget_range: string
  first_name: string
  last_name: string
  phone: string
  email: string
  city: string
  state: string
}

type ScoreResult = {
  total: number
  qualification: 'hot' | 'warm' | 'cold' | 'unqualified'
  summary: string
  recommended_action: string
} | null

type StepProps = {
  data: FormData
  update: (field: keyof FormData, value: string | boolean | null) => void
}

// =============================================
// STEP DEFINITIONS
// =============================================
const DENTAL_CONDITIONS = [
  { value: 'missing_all_both', label: 'Missing All or Most Teeth', icon: '😟', desc: 'Upper and/or lower teeth are gone' },
  { value: 'failing_teeth', label: 'Failing or Decaying Teeth', icon: '🦷', desc: 'Teeth are breaking down, need replacement' },
  { value: 'denture_problems', label: 'Unhappy with Dentures', icon: '😤', desc: 'Current dentures are loose, painful, or uncomfortable' },
  { value: 'missing_multiple', label: 'Missing Several Teeth', icon: '😬', desc: 'Some teeth are missing, affecting my smile' },
  { value: 'missing_all_upper', label: 'Missing Upper Teeth', icon: '⬆️', desc: 'Upper arch needs full restoration' },
  { value: 'missing_all_lower', label: 'Missing Lower Teeth', icon: '⬇️', desc: 'Lower arch needs full restoration' },
  { value: 'other', label: 'Something Else', icon: '❓', desc: "I'm not sure — I need an evaluation" },
]

const URGENCY_OPTIONS = [
  { value: 'asap', label: "ASAP — I'm Ready", icon: '🔥', desc: "I'm in pain or want to start immediately" },
  { value: '1_3_months', label: 'Within 1-3 Months', icon: '📅', desc: "I'm actively looking and want to move soon" },
  { value: '6_months', label: 'Within 6 Months', icon: '🗓️', desc: "I'm planning ahead, gathering information" },
  { value: 'researching', label: 'Just Researching', icon: '🔍', desc: "I want to learn more before deciding" },
]

const FINANCING_OPTIONS = [
  { value: 'cash_pay', label: 'Cash or Savings', icon: '💰', desc: "I'm ready to pay out of pocket" },
  { value: 'financing_needed', label: "I'll Need Financing", icon: '📋', desc: 'Monthly payments would work best' },
  { value: 'insurance_only', label: 'Dental Insurance', icon: '🏥', desc: "I'd like to use my insurance benefits" },
  { value: 'undecided', label: 'Not Sure Yet', icon: '🤔', desc: 'I want to explore my options' },
]

const BUDGET_OPTIONS = [
  { value: 'under_10k', label: 'Under $10,000', desc: 'Per arch' },
  { value: '10k_15k', label: '$10,000 - $15,000', desc: 'Per arch' },
  { value: '15k_20k', label: '$15,000 - $20,000', desc: 'Per arch' },
  { value: '20k_25k', label: '$20,000 - $25,000', desc: 'Per arch' },
  { value: 'over_30k', label: 'Over $25,000', desc: 'Per arch or full mouth' },
  { value: 'unknown', label: "I'm Not Sure", desc: "I'd like to discuss options" },
]

// =============================================
// CARD SELECTOR COMPONENT
// =============================================
function CardSelector({
  options,
  value,
  onChange,
  columns = 2,
}: {
  options: Array<{ value: string; label: string; icon?: string; desc?: string }>
  value: string
  onChange: (value: string) => void
  columns?: 1 | 2 | 3
}) {
  return (
    <div className={cn(
      'grid gap-3',
      columns === 1 ? 'grid-cols-1' : columns === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'
    )}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            'flex items-start gap-3 rounded-xl border-2 p-4 text-left transition-all hover:shadow-md',
            value === opt.value
              ? 'border-blue-600 bg-blue-50 shadow-md ring-1 ring-blue-600'
              : 'border-gray-200 bg-white hover:border-gray-300'
          )}
        >
          {opt.icon && <span className="text-2xl mt-0.5 shrink-0">{opt.icon}</span>}
          <div>
            <p className={cn(
              'font-semibold text-sm',
              value === opt.value ? 'text-blue-900' : 'text-gray-900'
            )}>
              {opt.label}
            </p>
            {opt.desc && (
              <p className={cn(
                'text-xs mt-0.5',
                value === opt.value ? 'text-blue-700' : 'text-gray-500'
              )}>
                {opt.desc}
              </p>
            )}
          </div>
          <div className={cn(
            'ml-auto mt-1 h-5 w-5 rounded-full border-2 shrink-0 flex items-center justify-center',
            value === opt.value ? 'border-blue-600 bg-blue-600' : 'border-gray-300'
          )}>
            {value === opt.value && (
              <svg className="h-3 w-3 text-white" fill="currentColor" viewBox="0 0 12 12">
                <path d="M10.28 2.28L3.989 8.575 1.695 6.28A1 1 0 00.28 7.695l3 3a1 1 0 001.414 0l7-7A1 1 0 0010.28 2.28z" />
              </svg>
            )}
          </div>
        </button>
      ))}
    </div>
  )
}

// =============================================
// INDIVIDUAL STEPS
// =============================================
function Step1Condition({ data, update }: StepProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        What best describes your smile situation?
      </h2>
      <p className="text-gray-500 mb-6">
        This helps us understand how we can help you.
      </p>
      <CardSelector
        options={DENTAL_CONDITIONS}
        value={data.dental_condition}
        onChange={(v) => update('dental_condition', v)}
      />
    </div>
  )
}

function Step2Urgency({ data, update }: StepProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        How soon are you looking to get started?
      </h2>
      <p className="text-gray-500 mb-6">
        There&apos;s no wrong answer — we meet you where you are.
      </p>
      <CardSelector
        options={URGENCY_OPTIONS}
        value={data.urgency}
        onChange={(v) => update('urgency', v)}
      />
    </div>
  )
}

function Step3Details({ data, update }: StepProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        Tell us more about your situation
      </h2>
      <p className="text-gray-500 mb-6">
        The more we know, the better we can help.
      </p>
      <div className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Describe what you&apos;re experiencing
          </label>
          <textarea
            value={data.dental_condition_details}
            onChange={(e) => update('dental_condition_details', e.target.value)}
            rows={4}
            placeholder="For example: I've had dentures for 5 years and they slip constantly. I can't eat the foods I love. I want a permanent solution..."
            className="w-full rounded-xl border-2 border-gray-200 px-4 py-3 text-sm focus:border-blue-600 focus:ring-1 focus:ring-blue-600 outline-none transition-colors resize-none"
          />
        </div>
        <div className="flex items-center justify-between rounded-xl border-2 border-gray-200 p-4">
          <div>
            <p className="font-medium text-gray-900 text-sm">Do you currently wear dentures?</p>
            <p className="text-xs text-gray-500">This helps us understand your starting point</p>
          </div>
          <div className="flex gap-2">
            {[
              { label: 'Yes', value: true },
              { label: 'No', value: false },
            ].map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => update('has_dentures', opt.value)}
                className={cn(
                  'rounded-lg px-5 py-2 text-sm font-medium transition-colors',
                  data.has_dentures === opt.value
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Step4Financing({ data, update }: StepProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        How would you like to handle payment?
      </h2>
      <p className="text-gray-500 mb-6">
        We offer flexible options to make your dream smile affordable.
      </p>
      <CardSelector
        options={FINANCING_OPTIONS}
        value={data.financing_interest}
        onChange={(v) => update('financing_interest', v)}
      />
      {data.financing_interest === 'insurance_only' && (
        <div className="mt-4">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Insurance provider (optional)
          </label>
          <input
            value={data.insurance_provider}
            onChange={(e) => update('insurance_provider', e.target.value)}
            placeholder="e.g. Delta Dental, Cigna, Aetna..."
            className="w-full rounded-xl border-2 border-gray-200 px-4 py-3 text-sm focus:border-blue-600 focus:ring-1 focus:ring-blue-600 outline-none transition-colors"
          />
        </div>
      )}
    </div>
  )
}

function Step5Budget({ data, update }: StepProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        What&apos;s your budget range?
      </h2>
      <p className="text-gray-500 mb-6">
        This helps us recommend the right treatment plan for you.
      </p>
      <CardSelector
        options={BUDGET_OPTIONS}
        value={data.budget_range}
        onChange={(v) => update('budget_range', v)}
        columns={2}
      />
    </div>
  )
}

function Step6Contact({ data, update }: StepProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        Almost done! How can we reach you?
      </h2>
      <p className="text-gray-500 mb-6">
        We&apos;ll send you a personalized treatment overview.
      </p>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">First Name *</label>
            <input
              value={data.first_name}
              onChange={(e) => update('first_name', e.target.value)}
              placeholder="John"
              required
              className="w-full rounded-xl border-2 border-gray-200 px-4 py-3 text-sm focus:border-blue-600 focus:ring-1 focus:ring-blue-600 outline-none transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Last Name</label>
            <input
              value={data.last_name}
              onChange={(e) => update('last_name', e.target.value)}
              placeholder="Smith"
              className="w-full rounded-xl border-2 border-gray-200 px-4 py-3 text-sm focus:border-blue-600 focus:ring-1 focus:ring-blue-600 outline-none transition-colors"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Phone Number *</label>
          <input
            value={data.phone}
            onChange={(e) => update('phone', e.target.value)}
            type="tel"
            placeholder="(555) 123-4567"
            required
            className="w-full rounded-xl border-2 border-gray-200 px-4 py-3 text-sm focus:border-blue-600 focus:ring-1 focus:ring-blue-600 outline-none transition-colors"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Email</label>
          <input
            value={data.email}
            onChange={(e) => update('email', e.target.value)}
            type="email"
            placeholder="john@example.com"
            className="w-full rounded-xl border-2 border-gray-200 px-4 py-3 text-sm focus:border-blue-600 focus:ring-1 focus:ring-blue-600 outline-none transition-colors"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">City</label>
            <input
              value={data.city}
              onChange={(e) => update('city', e.target.value)}
              placeholder="San Francisco"
              className="w-full rounded-xl border-2 border-gray-200 px-4 py-3 text-sm focus:border-blue-600 focus:ring-1 focus:ring-blue-600 outline-none transition-colors"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">State</label>
            <input
              value={data.state}
              onChange={(e) => update('state', e.target.value)}
              placeholder="CA"
              maxLength={2}
              className="w-full rounded-xl border-2 border-gray-200 px-4 py-3 text-sm focus:border-blue-600 focus:ring-1 focus:ring-blue-600 outline-none transition-colors"
            />
          </div>
        </div>
        <p className="text-xs text-gray-400 text-center mt-2">
          Your information is secure and will never be shared with third parties.
        </p>
      </div>
    </div>
  )
}

function Step7Success({ score, data }: { score: ScoreResult; data: FormData }) {
  const qualMessages: Record<string, { title: string; desc: string; color: string; bg: string }> = {
    hot: {
      title: "Great news — you're an excellent candidate!",
      desc: "Based on your answers, you're a strong fit for All-on-4 dental implants. Let's get you scheduled for a free consultation.",
      color: 'text-green-700',
      bg: 'bg-green-50 border-green-200',
    },
    warm: {
      title: "You're on the right track!",
      desc: "All-on-4 implants could be a great solution for you. A consultation will help us create your personalized treatment plan.",
      color: 'text-blue-700',
      bg: 'bg-blue-50 border-blue-200',
    },
    cold: {
      title: "Thank you for your interest!",
      desc: "We'd love to learn more about your situation. A consultation will help us determine the best path forward for your smile.",
      color: 'text-indigo-700',
      bg: 'bg-indigo-50 border-indigo-200',
    },
    unqualified: {
      title: "Thanks for reaching out!",
      desc: "We'll review your information and reach out with options that may work for your situation.",
      color: 'text-gray-700',
      bg: 'bg-gray-50 border-gray-200',
    },
  }

  const qual = score ? qualMessages[score.qualification] || qualMessages.warm : qualMessages.warm

  return (
    <div className="text-center">
      <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-100 mb-6">
        <svg className="w-10 h-10 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>

      <h2 className={cn('text-2xl font-bold mb-3', qual.color)}>
        {qual.title}
      </h2>

      <div className={cn('rounded-xl border-2 p-5 mb-6', qual.bg)}>
        <p className="text-sm text-gray-700">{qual.desc}</p>
        {score && (
          <div className="mt-4 flex justify-center gap-4">
            <div className="text-center">
              <div className="text-3xl font-bold text-gray-900">{score.total}</div>
              <div className="text-xs text-gray-500">Match Score</div>
            </div>
          </div>
        )}
      </div>

      <p className="text-gray-600 text-sm mb-6">
        {data.first_name}, we&apos;ll be in touch within 24 hours at <strong>{data.phone}</strong>
        {data.email ? <> and <strong>{data.email}</strong></> : null} to schedule your free consultation.
      </p>

      <div className="rounded-xl bg-gray-50 border border-gray-200 p-4">
        <p className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-2">What happens next?</p>
        <div className="space-y-2 text-sm text-gray-600 text-left">
          <div className="flex items-start gap-2">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-xs font-bold shrink-0 mt-0.5">1</span>
            <span>Our team reviews your information</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-xs font-bold shrink-0 mt-0.5">2</span>
            <span>We contact you to schedule a free consultation</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-xs font-bold shrink-0 mt-0.5">3</span>
            <span>Meet the doctor and get your personalized treatment plan</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// =============================================
// PROGRESS BAR
// =============================================
function ProgressBar({ current, total }: { current: number; total: number }) {
  return (
    <div className="mb-8">
      <div className="flex justify-between text-xs text-gray-400 mb-2">
        <span>Step {current} of {total}</span>
        <span>{Math.round((current / total) * 100)}% complete</span>
      </div>
      <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-600 transition-all duration-500 ease-out"
          style={{ width: `${(current / total) * 100}%` }}
        />
      </div>
    </div>
  )
}

// =============================================
// MAIN FORM
// =============================================
export function QualificationForm({
  orgId,
  orgName,
  apiBase = '',
  utmParams = {},
}: {
  orgId: string
  orgName?: string
  apiBase?: string
  utmParams?: Record<string, string>
}) {
  const TOTAL_STEPS = 6
  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [score, setScore] = useState<ScoreResult>(null)

  const [data, setData] = useState<FormData>({
    dental_condition: '',
    urgency: '',
    dental_condition_details: '',
    has_dentures: null,
    financing_interest: '',
    has_dental_insurance: null,
    insurance_provider: '',
    budget_range: '',
    first_name: '',
    last_name: '',
    phone: '',
    email: '',
    city: '',
    state: '',
  })

  const update = useCallback((field: keyof FormData, value: string | boolean | null) => {
    setData((prev) => ({ ...prev, [field]: value }))
  }, [])

  function canProceed(): boolean {
    switch (step) {
      case 1: return !!data.dental_condition
      case 2: return !!data.urgency
      case 3: return true // details are optional
      case 4: return !!data.financing_interest
      case 5: return !!data.budget_range
      case 6: return !!data.first_name && !!data.phone && data.phone.replace(/\D/g, '').length >= 7
      default: return false
    }
  }

  async function handleSubmit() {
    setSubmitting(true)
    try {
      const payload = {
        ...data,
        has_dental_insurance: data.financing_interest === 'insurance_only',
        source_type: utmParams.source_type || 'landing_page',
        utm_source: utmParams.utm_source || undefined,
        utm_medium: utmParams.utm_medium || undefined,
        utm_campaign: utmParams.utm_campaign || undefined,
        utm_content: utmParams.utm_content || undefined,
        utm_term: utmParams.utm_term || undefined,
        gclid: utmParams.gclid || undefined,
        fbclid: utmParams.fbclid || undefined,
        landing_page_url: typeof window !== 'undefined' ? window.location.href : undefined,
      }

      const url = `${apiBase}/api/webhooks/qualify?org=${orgId}`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) throw new Error('Submission failed')

      const result = await res.json()
      setScore(result.score)
      setSubmitted(true)

      // Fire conversion tracking
      if (typeof window !== 'undefined') {
        if ((window as any).gtag) {
          (window as any).gtag('event', 'conversion', { send_to: 'lead_qualification_complete' })
        }
        if ((window as any).fbq) {
          (window as any).fbq('track', 'Lead')
        }
      }
    } catch {
      alert('Something went wrong. Please try again or call us directly.')
    } finally {
      setSubmitting(false)
    }
  }

  function next() {
    if (step === TOTAL_STEPS) {
      handleSubmit()
    } else {
      setStep((s) => s + 1)
    }
  }

  function back() {
    setStep((s) => Math.max(1, s - 1))
  }

  if (submitted) {
    return (
      <div className="max-w-lg mx-auto px-4 py-8">
        {orgName && (
          <p className="text-center text-sm text-gray-400 mb-6">{orgName}</p>
        )}
        <Step7Success score={score} data={data} />
      </div>
    )
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-6">
      {orgName && (
        <p className="text-center text-sm text-gray-400 mb-4">{orgName}</p>
      )}

      <ProgressBar current={step} total={TOTAL_STEPS} />

      <div className="min-h-[400px]">
        {step === 1 && <Step1Condition data={data} update={update} />}
        {step === 2 && <Step2Urgency data={data} update={update} />}
        {step === 3 && <Step3Details data={data} update={update} />}
        {step === 4 && <Step4Financing data={data} update={update} />}
        {step === 5 && <Step5Budget data={data} update={update} />}
        {step === 6 && <Step6Contact data={data} update={update} />}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between mt-8">
        {step > 1 ? (
          <button
            type="button"
            onClick={back}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Back
          </button>
        ) : (
          <div />
        )}

        <button
          type="button"
          onClick={next}
          disabled={!canProceed() || submitting}
          className={cn(
            'flex items-center gap-2 rounded-xl px-8 py-3.5 text-sm font-semibold transition-all',
            canProceed() && !submitting
              ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-600/25 hover:shadow-xl'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          )}
        >
          {submitting ? (
            <>
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Analyzing...
            </>
          ) : step === TOTAL_STEPS ? (
            'Get My Results'
          ) : (
            <>
              Continue
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
