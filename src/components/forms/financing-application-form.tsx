'use client'

import { useState, useCallback } from 'react'

type ApplicantType = '' | 'self' | 'on_behalf'
type Relationship = '' | 'spouse' | 'parent' | 'adult_child' | 'other_family' | 'friend' | 'other'

type FormData = {
  applicant_type: ApplicantType
  relationship: Relationship
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
  status: 'approved' | 'denied' | 'in_progress' | 'error' | 'awaiting_patient'
  approved_lender?: string
  approved_amount?: number
  /** Populated for `awaiting_patient`: the lender apply links the patient must finish. */
  links?: Array<{ lender: string; url: string }>
} | null

// Client-side lender display names (the server's LENDER_INFO isn't importable here).
const LENDER_NAMES: Record<string, string> = {
  carecredit: 'CareCredit', sunbit: 'Sunbit', proceed: 'Proceed Finance',
  lendingclub: 'LendingClub', cherry: 'Cherry', alpheon: 'Alpheon Credit', affirm: 'Affirm',
}

type StepConfig = { ok: (d: FormData) => boolean }

const STEPS: StepConfig[] = [
  { ok: (d) => d.applicant_type === 'self' || (d.applicant_type === 'on_behalf' && !!d.relationship) },
  { ok: (d) => !!d.first_name && !!d.last_name && !!d.email && d.email.includes('@') && !!d.phone && d.phone.replace(/\D/g, '').length >= 10 && !!d.date_of_birth },
  { ok: (d) => !!d.street_address && !!d.city && d.state.length === 2 && /^\d{5}$/.test(d.zip_code) },
  { ok: (d) => !!d.employment_status && !!d.annual_income && Number(d.annual_income) > 0 },
  { ok: (d) => d.ssn.replace(/\D/g, '').length === 9 && d.consent_given },
]

const RELATIONSHIPS: { value: Relationship; label: string }[] = [
  { value: 'spouse', label: 'Spouse / partner' },
  { value: 'parent', label: 'Parent' },
  { value: 'adult_child', label: 'Adult child' },
  { value: 'other_family', label: 'Other family member' },
  { value: 'friend', label: 'Friend' },
  { value: 'other', label: 'Other' },
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

// ── Intro Step: Who's applying? ────────────────────────────────

function StepWhoApplies({
  d,
  patientFirstName,
  onSelfSelect,
  onBehalfSelect,
  setRelationship,
}: {
  d: FormData
  patientFirstName: string
  onSelfSelect: () => void
  onBehalfSelect: () => void
  setRelationship: (r: Relationship) => void
}) {
  const patient = patientFirstName || 'the patient'
  return (
    <div>
      <H>Who&apos;s applying?</H>
      <P>You can apply yourself, or have a family member or friend with stronger credit apply on your behalf. Whoever applies is the person we check — this is a soft pull and won&apos;t affect their score.</P>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <Pill sel={d.applicant_type === 'self'} click={onSelfSelect}>
          {`I'm ${patient} — I'm applying for myself`}
        </Pill>
        <Pill sel={d.applicant_type === 'on_behalf'} click={onBehalfSelect}>
          {`I'm applying on ${patient}'s behalf`}
        </Pill>
      </div>

      {d.applicant_type === 'on_behalf' && (
        <div style={{ marginTop: '20px' }}>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '10px' }}>
            How are you related to {patient}? *
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {RELATIONSHIPS.map((r) => (
              <Pill key={r.value} sel={d.relationship === r.value} click={() => setRelationship(r.value)}>
                {r.label}
              </Pill>
            ))}
          </div>
          <p style={{ fontSize: '13px', color: '#78716c', marginTop: '12px', lineHeight: 1.5 }}>
            On the next steps, enter <strong>your own</strong> information — you&apos;re the person being checked for financing.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Step 1: Personal Info ──────────────────────────────────────

function Step1({ d, u, onBehalf, patientFirstName }: { d: FormData; u: (f: keyof FormData, v: string) => void; onBehalf: boolean; patientFirstName: string }) {
  return (
    <div>
      <H>{onBehalf ? 'Your Information' : 'Personal Information'}</H>
      <P>
        {onBehalf
          ? `Enter your own details — you're the person we'll check for financing on ${patientFirstName || 'the patient'}'s behalf. Everything is encrypted and HIPAA compliant.`
          : 'We need a few basic details. Everything is encrypted and HIPAA compliant.'}
      </P>
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

function Step4({ d, u, uBool, onBehalf, patientFirstName }: { d: FormData; u: (f: keyof FormData, v: string) => void; uBool: (f: keyof FormData, v: boolean) => void; onBehalf: boolean; patientFirstName: string }) {
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
            {onBehalf && (
              <> I confirm I am applying to finance dental treatment for <strong>{patientFirstName || 'the patient'}</strong> and that the credit check is run on <strong>me</strong> as the applicant.</>
            )}
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

  if (result.status === 'awaiting_patient') {
    return (
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: '#fffbeb', border: '3px solid #fbbf24', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '20px' }}>
          <span style={{ fontSize: '36px' }}>🔗</span>
        </div>
        <h2 style={{ fontSize: '24px', fontWeight: 800, color: '#1f1a15', marginBottom: '8px' }}>One Quick Step, {firstName}</h2>
        <p style={{ fontSize: '16px', color: '#57534e', lineHeight: 1.6, margin: '16px 0' }}>
          You&apos;re matched with {result.links && result.links.length > 1 ? 'these lending partners' : 'a lending partner'}. Tap below to finish your application on their secure site — it only takes a minute.
        </p>
        {result.links && result.links.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', margin: '20px 0', textAlign: 'left' }}>
            {result.links.map((lnk) => (
              <a key={lnk.url} href={lnk.url} target="_blank" rel="noopener noreferrer" style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
                padding: '16px 18px', borderRadius: '14px', border: '3px solid #d97706', background: '#fffbeb',
                textDecoration: 'none', color: '#1f1a15', fontWeight: 700, fontSize: '16px',
              }}>
                <span>Continue with {lnk.lender}</span>
                <span style={{ fontSize: '18px' }}>→</span>
              </a>
            ))}
          </div>
        )}
        <p style={{ fontSize: '13px', color: '#78716c', lineHeight: 1.5, margin: '8px 0 0' }}>
          We&apos;ll also follow up personally to help you through it. Questions? Just reply to our text.
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
  patientFirstName = '',
  prefill,
}: {
  applicationId: string
  shareToken: string
  requestedAmount?: number | null
  patientFirstName?: string
  prefill?: Partial<FormData>
}) {
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<FormResult>(null)
  const [error, setError] = useState('')
  const [d, setD] = useState<FormData>({
    applicant_type: '',
    relationship: '',
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

  // Patient applies for themselves → prefill their name. A substitute applicant
  // enters their OWN identity, so clear the patient's prefilled name.
  const selectSelf = useCallback(() => setD((p) => ({
    ...p,
    applicant_type: 'self',
    relationship: '',
    first_name: prefill?.first_name || '',
    last_name: prefill?.last_name || '',
  })), [prefill?.first_name, prefill?.last_name])
  const selectOnBehalf = useCallback(() => setD((p) => ({
    ...p,
    applicant_type: 'on_behalf',
    first_name: '',
    last_name: '',
  })), [])
  const setRelationship = useCallback((r: Relationship) => setD((p) => ({ ...p, relationship: r })), [])

  const onBehalf = d.applicant_type === 'on_behalf'
  // Single source of truth for the patient's display name (leads are stored
  // lower-cased in some sources) — passed to every step that references it.
  const patientName = patientFirstName
    ? patientFirstName.charAt(0).toUpperCase() + patientFirstName.slice(1)
    : ''

  const cfg = STEPS[step - 1]
  const ok = cfg?.ok(d) ?? false
  const totalSteps = STEPS.length

  async function submit() {
    setBusy(true)
    setError('')
    try {
      const payload = {
        applicant_type: d.applicant_type || 'self',
        applicant_relationship: onBehalf && d.relationship ? d.relationship : undefined,
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
      // Show the optimistic "submitted" screen immediately, then poll for the
      // real terminal outcome — the waterfall runs in the background (next/server
      // after()), so the apply response is always "processing". Polling lets us
      // upgrade the screen to approved / apply-links / etc. once it resolves.
      setResult({ status: 'in_progress' })
      const appId: string | undefined = data.application_id
      if (appId) void pollForOutcome(appId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please call the office directly.')
    } finally {
      setBusy(false)
    }
  }

  // Poll the application until it reaches a terminal state (or we give up and
  // leave the honest "we'll be in touch" screen up). Runs for ~30s.
  async function pollForOutcome(appId: string) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    for (let attempt = 0; attempt < 12; attempt++) {
      await sleep(2500)
      try {
        const r = await fetch(`/api/financing/${appId}`, { headers: { 'x-share-token': shareToken } })
        if (!r.ok) continue
        const d = await r.json()
        const st: string = d.status
        if (st === 'approved' || st === 'denied' || st === 'awaiting_patient' || st === 'error') {
          const links = Array.isArray(d.submissions)
            ? d.submissions
                .filter((s: { status?: string; application_url?: string }) => s.status === 'link_sent' && s.application_url)
                .map((s: { lender_slug: string; application_url: string }) => ({
                  lender: LENDER_NAMES[s.lender_slug] || s.lender_slug,
                  url: s.application_url,
                }))
            : []
          setResult({
            status: st as NonNullable<FormResult>['status'],
            approved_lender: d.approved_lender_slug ? (LENDER_NAMES[d.approved_lender_slug] || d.approved_lender_slug) : undefined,
            approved_amount: d.approved_amount ?? undefined,
            links: links.length ? links : undefined,
          })
          return
        }
      } catch { /* transient — keep polling */ }
    }
  }

  if (result) {
    return <ResultScreen result={result} firstName={d.first_name} />
  }

  return (
    <div>
      <Bar c={step} t={totalSteps} />

      <div style={{ minHeight: '360px' }}>
        {step === 1 && (
          <StepWhoApplies
            d={d}
            patientFirstName={patientName}
            onSelfSelect={selectSelf}
            onBehalfSelect={selectOnBehalf}
            setRelationship={setRelationship}
          />
        )}
        {step === 2 && <Step1 d={d} u={u} onBehalf={onBehalf} patientFirstName={patientName} />}
        {step === 3 && <Step2 d={d} u={u} />}
        {step === 4 && <Step3 d={d} u={u} />}
        {step === 5 && <Step4 d={d} u={u} uBool={uBool} onBehalf={onBehalf} patientFirstName={patientName} />}
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
