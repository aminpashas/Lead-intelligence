'use client'

import { useState, useCallback } from 'react'

type FormData = {
  first_name: string
  last_name: string
  date_of_birth: string
  ssn: string
  email: string
  phone: string
  street_address: string
  city: string
  state: string
  zip_code: string
  annual_income: string
  employment_status: string
  employer_name: string
  requested_amount: string
  consent_given: boolean
}

type FormResult = {
  status: 'approved' | 'denied' | 'in_progress' | 'error'
  approved_lender?: string
  approved_amount?: number
} | null

type StepConfig = { ok: (d: FormData) => boolean }

const STEPS: StepConfig[] = [
  { ok: (d) => !!d.first_name && !!d.last_name && !!d.email && d.email.includes('@') && !!d.phone && d.phone.replace(/\D/g, '').length >= 10 && !!d.date_of_birth },
  { ok: (d) => !!d.street_address && !!d.city && d.state.length === 2 && /^\d{5}$/.test(d.zip_code) },
  { ok: (d) => !!d.employment_status && !!d.annual_income && Number(d.annual_income) > 0 },
  { ok: (d) => d.ssn.replace(/\D/g, '').length === 9 && d.consent_given },
]

// ── Shared Components ─────────────────────────────────────────

function H({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: '22px', fontWeight: 800, color: '#1f1a15', lineHeight: 1.3, marginBottom: '6px' }}>{children}</h2>
}

function P({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: '15px', color: '#78716c', marginBottom: '22px', lineHeight: 1.5 }}>{children}</p>
}

function InputField({ label, required, ...props }: { label: string; required?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>
        {label} {required && '*'}
      </label>
      <input
        {...props}
        style={{
          width: '100%', padding: '14px 16px', fontSize: '16px', border: '3px solid #e5e0d8',
          borderRadius: '14px', outline: 'none', background: '#fff', color: '#1f1a15',
          boxSizing: 'border-box' as const,
          ...(props.style || {}),
        }}
      />
    </div>
  )
}

function Pill({ sel, click, children }: { sel: boolean; click: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={click} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: '14px', padding: '14px 16px',
      borderRadius: '14px', border: `3px solid ${sel ? '#d97706' : '#e5e0d8'}`,
      background: sel ? '#fffbeb' : '#fff', cursor: 'pointer', transition: 'all .15s',
      boxShadow: sel ? '0 0 0 1px #d97706' : 'none', textAlign: 'left' as const,
    }}>
      <span style={{ width: '22px', height: '22px', borderRadius: '50%', border: `3px solid ${sel ? '#d97706' : '#ccc'}`,
        background: sel ? '#d97706' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {sel && <svg width="12" height="12" viewBox="0 0 12 12" fill="#fff"><path d="M10.28 2.28L3.989 8.575 1.695 6.28A1 1 0 00.28 7.695l3 3a1 1 0 001.414 0l7-7A1 1 0 0010.28 2.28z"/></svg>}
      </span>
      <span style={{ fontSize: '15px', fontWeight: 600, color: '#1f1a15', lineHeight: 1.4 }}>{children}</span>
    </button>
  )
}

function Bar({ c, t }: { c: number; t: number }) {
  const p = Math.round(((c) / t) * 100)
  return (
    <div style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 600, color: '#78716c', marginBottom: '6px' }}>
        <span>Step {c} of {t}</span><span>{p}%</span>
      </div>
      <div style={{ height: '10px', borderRadius: '99px', background: '#e5e0d8', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: '99px', background: 'linear-gradient(90deg,#d97706,#f59e0b)', width: `${p}%`, transition: 'width .5s ease' }} />
      </div>
    </div>
  )
}

// ── Step 1: Personal Info ──────────────────────────────────────

function Step1({ d, u }: { d: FormData; u: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <H>Personal Information</H>
      <P>We need a few basic details. Everything is encrypted and HIPAA compliant.</P>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <InputField label="First Name" required value={d.first_name} onChange={(e) => u('first_name', e.target.value)} placeholder="First name" />
          <InputField label="Last Name" required value={d.last_name} onChange={(e) => u('last_name', e.target.value)} placeholder="Last name" />
        </div>
        <InputField label="Date of Birth" required type="date" value={d.date_of_birth} onChange={(e) => u('date_of_birth', e.target.value)} />
        <InputField label="Email" required type="email" value={d.email} onChange={(e) => u('email', e.target.value)} placeholder="your@email.com"
          style={d.email && d.email.includes('@') ? { border: '3px solid #16a34a' } : undefined} />
        <div>
          <InputField label="Phone Number" required type="tel" value={d.phone} onChange={(e) => u('phone', e.target.value)} placeholder="(555) 123-4567"
            style={{ border: '3px solid #d97706', background: '#fffbeb', fontSize: '18px', fontWeight: 600 }} />
          <p style={{ fontSize: '12px', color: '#78716c', marginTop: '4px' }}>We may call to verify your identity</p>
        </div>
      </div>
    </div>
  )
}

// ── Step 2: Address ────────────────────────────────────────────

function Step2({ d, u }: { d: FormData; u: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <H>Home Address</H>
      <P>Required for the credit application. This will NOT affect your credit score.</P>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <InputField label="Street Address" required value={d.street_address} onChange={(e) => u('street_address', e.target.value)} placeholder="123 Main Street" />
        <InputField label="City" required value={d.city} onChange={(e) => u('city', e.target.value)} placeholder="San Francisco" />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <InputField label="State" required value={d.state} onChange={(e) => u('state', e.target.value.toUpperCase())} placeholder="CA" maxLength={2} />
          <InputField label="ZIP Code" required value={d.zip_code} onChange={(e) => u('zip_code', e.target.value)} placeholder="94108" maxLength={5} />
        </div>
      </div>
    </div>
  )
}

// ── Step 3: Employment ─────────────────────────────────────────

function Step3({ d, u }: { d: FormData; u: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <H>Employment &amp; Income</H>
      <P>This helps lenders find the best rates for you. Almost done!</P>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '18px' }}>
        <Pill sel={d.employment_status === 'employed'} click={() => u('employment_status', 'employed')}>Employed</Pill>
        <Pill sel={d.employment_status === 'self_employed'} click={() => u('employment_status', 'self_employed')}>Self-Employed</Pill>
        <Pill sel={d.employment_status === 'retired'} click={() => u('employment_status', 'retired')}>Retired</Pill>
        <Pill sel={d.employment_status === 'other'} click={() => u('employment_status', 'other')}>Other</Pill>
      </div>
      {d.employment_status === 'employed' && (
        <div style={{ marginBottom: '14px' }}>
          <InputField label="Employer Name" value={d.employer_name} onChange={(e) => u('employer_name', e.target.value)} placeholder="Company name" />
        </div>
      )}
      <div>
        <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>Annual Income *</label>
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', fontSize: '18px', fontWeight: 700, color: '#78716c' }}>$</span>
          <input
            type="number"
            value={d.annual_income}
            onChange={(e) => u('annual_income', e.target.value)}
            placeholder="55,000"
            style={{
              width: '100%', padding: '14px 16px 14px 32px', fontSize: '18px', fontWeight: 600,
              border: '3px solid #e5e0d8', borderRadius: '14px', outline: 'none', background: '#fff',
              color: '#1f1a15', boxSizing: 'border-box',
            }}
          />
        </div>
        <p style={{ fontSize: '12px', color: '#78716c', marginTop: '4px' }}>Before taxes. Include all income sources.</p>
      </div>
    </div>
  )
}

// ── Step 4: SSN + Consent ──────────────────────────────────────

function Step4({ d, u, uBool }: { d: FormData; u: (f: keyof FormData, v: string) => void; uBool: (f: keyof FormData, v: boolean) => void }) {
  function formatSSN(val: string): string {
    const digits = val.replace(/\D/g, '').slice(0, 9)
    if (digits.length <= 3) return digits
    if (digits.length <= 5) return `${digits.slice(0, 3)}-${digits.slice(3)}`
    return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`
  }

  return (
    <div>
      <H>Last Step — Verification</H>
      <P>Your SSN is needed for the credit check. It&apos;s encrypted and never stored in plain text.</P>

      <div style={{ background: '#eff6ff', border: '2px solid #bfdbfe', borderRadius: '14px', padding: '14px 18px', marginBottom: '18px', display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <span style={{ fontSize: '18px', flexShrink: 0 }}>🛡️</span>
        <div>
          <p style={{ fontSize: '14px', fontWeight: 700, color: '#1e40af', margin: '0 0 4px' }}>Soft Credit Pull Only</p>
          <p style={{ fontSize: '13px', color: '#3b82f6', margin: 0, lineHeight: 1.4 }}>This will NOT affect your credit score. It&apos;s just a pre-qualification check.</p>
        </div>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>Social Security Number *</label>
        <input
          type="password"
          inputMode="numeric"
          value={formatSSN(d.ssn)}
          onChange={(e) => u('ssn', e.target.value.replace(/\D/g, ''))}
          placeholder="•••-••-••••"
          maxLength={11}
          autoComplete="off"
          style={{
            width: '100%', padding: '16px 18px', fontSize: '22px', fontWeight: 700, letterSpacing: '3px',
            border: '3px solid #e5e0d8', borderRadius: '14px', outline: 'none', background: '#fff',
            color: '#1f1a15', boxSizing: 'border-box', textAlign: 'center',
          }}
        />
        <p style={{ fontSize: '12px', color: '#78716c', marginTop: '4px', textAlign: 'center' }}>
          🔒 AES-256 encrypted. HIPAA compliant. Deleted after 90 days.
        </p>
      </div>

      {/* Consent Checkboxes */}
      <div style={{ background: '#faf8f5', borderRadius: '14px', padding: '18px', border: '2px solid #e5e0d8' }}>
        <button
          type="button"
          onClick={() => uBool('consent_given', !d.consent_given)}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: '12px', background: 'none', border: 'none',
            cursor: 'pointer', textAlign: 'left', width: '100%', padding: 0,
          }}
        >
          <span style={{
            width: '24px', height: '24px', borderRadius: '6px', flexShrink: 0, marginTop: '2px',
            border: `3px solid ${d.consent_given ? '#16a34a' : '#ccc'}`,
            background: d.consent_given ? '#16a34a' : '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {d.consent_given && <svg width="14" height="14" viewBox="0 0 12 12" fill="#fff"><path d="M10.28 2.28L3.989 8.575 1.695 6.28A1 1 0 00.28 7.695l3 3a1 1 0 001.414 0l7-7A1 1 0 0010.28 2.28z"/></svg>}
          </span>
          <span style={{ fontSize: '13px', color: '#57534e', lineHeight: 1.5 }}>
            I authorize a <strong>soft credit pull</strong> for financing pre-qualification.
            I consent to sharing my information with lending partners for the purpose of obtaining dental financing.
            I understand this will <strong>not affect my credit score</strong>.
            I have read and agree to the HIPAA authorization for sharing protected health information.
          </span>
        </button>
      </div>
    </div>
  )
}

// ── Result Screen ──────────────────────────────────────────────

function ResultScreen({ result, firstName }: { result: FormResult; firstName: string }) {
  if (!result) return null

  if (result.status === 'approved') {
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: '#f0fdf4', border: '3px solid #bbf7d0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '20px' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
        </div>
        <h2 style={{ fontSize: '26px', fontWeight: 800, color: '#1f1a15', marginBottom: '8px' }}>You&apos;re Approved, {firstName}! 🎉</h2>
        {result.approved_amount && (
          <div style={{ background: 'linear-gradient(135deg,#f0fdf4,#dcfce7)', border: '3px solid #bbf7d0', borderRadius: '18px', padding: '22px', margin: '16px 0', display: 'inline-block' }}>
            <p style={{ fontSize: '14px', fontWeight: 700, color: '#166534', marginBottom: '4px' }}>APPROVED FOR</p>
            <div style={{ fontSize: '42px', fontWeight: 800, color: '#16a34a' }}>${result.approved_amount.toLocaleString()}</div>
            {result.approved_lender && <p style={{ fontSize: '13px', color: '#166534', marginTop: '4px' }}>via {result.approved_lender}</p>}
          </div>
        )}
        <p style={{ fontSize: '16px', color: '#57534e', lineHeight: 1.6, margin: '16px 0' }}>
          We&apos;ll call you within 24 hours to discuss your treatment plan and financing options.
        </p>
      </div>
    )
  }

  if (result.status === 'in_progress') {
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: '#fffbeb', border: '3px solid #fbbf24', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '20px' }}>
          <span style={{ fontSize: '36px' }}>⏳</span>
        </div>
        <h2 style={{ fontSize: '24px', fontWeight: 800, color: '#1f1a15', marginBottom: '8px' }}>Application Submitted, {firstName}!</h2>
        <p style={{ fontSize: '16px', color: '#57534e', lineHeight: 1.6, margin: '16px 0' }}>
          Your application is being reviewed by our lending partners. We&apos;ll contact you as soon as we have a decision — usually within a few hours.
        </p>
      </div>
    )
  }

  // Denied or error
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: '#fef2f2', border: '3px solid #fecaca', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '20px' }}>
        <span style={{ fontSize: '36px' }}>💬</span>
      </div>
      <h2 style={{ fontSize: '24px', fontWeight: 800, color: '#1f1a15', marginBottom: '8px' }}>Let&apos;s Talk Options, {firstName}</h2>
      <p style={{ fontSize: '16px', color: '#57534e', lineHeight: 1.6, margin: '16px 0' }}>
        We weren&apos;t able to get an instant approval, but don&apos;t give up! We have other options including co-signer plans and in-house payment arrangements. A team member will call you to discuss alternatives.
      </p>
    </div>
  )
}

// ── Public Form (via share token) ──────────────────────────────

export function FinancingApplicationFormPublic({
  applicationId,
  shareToken,
  requestedAmount,
  prefill,
}: {
  applicationId: string
  shareToken: string
  requestedAmount?: number | null
  prefill?: Partial<FormData>
}) {
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FormResult>(null)
  const [error, setError] = useState('')
  const [d, setD] = useState<FormData>({
    first_name: prefill?.first_name || '',
    last_name: prefill?.last_name || '',
    date_of_birth: '',
    ssn: '',
    email: prefill?.email || '',
    phone: prefill?.phone || '',
    street_address: '',
    city: prefill?.city || '',
    state: prefill?.state || '',
    zip_code: '',
    annual_income: '',
    employment_status: '',
    employer_name: '',
    requested_amount: requestedAmount?.toString() || '',
    consent_given: false,
  })

  const u = useCallback((f: keyof FormData, v: string) => setD((p) => ({ ...p, [f]: v })), [])
  const uBool = useCallback((f: keyof FormData, v: boolean) => setD((p) => ({ ...p, [f]: v })), [])

  const cfg = STEPS[step - 1]
  const ok = cfg?.ok(d) ?? false
  const totalSteps = STEPS.length

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const payload = {
        first_name: d.first_name,
        last_name: d.last_name,
        date_of_birth: d.date_of_birth,
        ssn: d.ssn.replace(/\D/g, ''),
        email: d.email,
        phone: d.phone,
        street_address: d.street_address,
        city: d.city,
        state: d.state,
        zip_code: d.zip_code,
        annual_income: Number(d.annual_income),
        employment_status: d.employment_status,
        employer_name: d.employer_name || undefined,
        requested_amount: Number(d.requested_amount) || 20000,
        consent_given: true,
      }

      const res = await fetch('/api/financing/apply', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-share-token': shareToken,
        },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Submission failed')
      }

      const data = await res.json()
      setResult({
        status: data.result?.status || 'in_progress',
        approved_lender: data.result?.approved_lender,
        approved_amount: data.result?.approved_amount,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please call the office directly.')
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    return <ResultScreen result={result} firstName={d.first_name} />
  }

  return (
    <div>
      <Bar c={step} t={totalSteps} />

      <div style={{ minHeight: '360px' }}>
        {step === 1 && <Step1 d={d} u={u} />}
        {step === 2 && <Step2 d={d} u={u} />}
        {step === 3 && <Step3 d={d} u={u} />}
        {step === 4 && <Step4 d={d} u={u} uBool={uBool} />}
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '2px solid #fecaca', borderRadius: '12px', padding: '12px 16px', marginTop: '12px' }}>
          <p style={{ fontSize: '14px', color: '#dc2626', margin: 0 }}>{error}</p>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '28px' }}>
        {step > 1 ? (
          <button type="button" onClick={() => setStep(s => s - 1)} style={{ fontSize: '15px', fontWeight: 600, color: '#78716c', background: 'none', border: 'none', cursor: 'pointer' }}>← Back</button>
        ) : <div />}
        <button
          type="button"
          onClick={() => step === totalSteps ? submit() : setStep(s => s + 1)}
          disabled={!ok || busy}
          style={{
            padding: '16px 32px', fontSize: '17px', fontWeight: 800, borderRadius: '14px', border: 'none',
            cursor: ok && !busy ? 'pointer' : 'not-allowed',
            background: ok && !busy ? 'linear-gradient(135deg,#d97706,#b45309)' : '#e5e0d8',
            color: ok && !busy ? '#fff' : '#a8a29e',
            boxShadow: ok && !busy ? '0 4px 14px rgba(217,119,6,.3)' : 'none',
            transition: 'all .15s', minWidth: '200px',
          }}
        >
          {busy ? 'Checking...' : step === totalSteps ? 'SUBMIT APPLICATION →' : 'NEXT →'}
        </button>
      </div>
    </div>
  )
}
