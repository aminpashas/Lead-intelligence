'use client'

import { useState, useCallback } from 'react'
import { cn } from '@/lib/utils'

// =============================================
// TYPES
// =============================================
type FormData = {
  // Step 1: Teeth situation
  teeth_situation: string
  teeth_count_upper: string
  teeth_count_lower: string
  has_dentures: string
  // Step 2: (education interstitial)
  // Step 3: Previous consults
  previous_consults: string
  previous_consult_locations: string
  what_held_back: string
  // Step 4: (education interstitial)
  // Step 5: Urgency
  urgency: string
  pain_level: string
  // Step 6: Credit / Financing
  credit_score_range: string
  monthly_payment_range: string
  has_cosigner: string
  financing_interest: string
  // Step 7: (education interstitial)
  // Step 8: Contact info
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

type StepConfig = {
  type: 'question' | 'education'
  canProceed: (data: FormData) => boolean
}

const STEP_CONFIG: StepConfig[] = [
  { type: 'question', canProceed: (d) => !!d.teeth_situation },                             // 1: teeth situation
  { type: 'education', canProceed: () => true },                                             // 2: education - what is all-on-4
  { type: 'question', canProceed: (d) => !!d.previous_consults },                           // 3: previous consults
  { type: 'education', canProceed: () => true },                                             // 4: education - the process
  { type: 'question', canProceed: (d) => !!d.urgency && !!d.pain_level },                   // 5: urgency + pain
  { type: 'question', canProceed: (d) => !!d.credit_score_range && !!d.monthly_payment_range }, // 6: financing
  { type: 'education', canProceed: () => true },                                             // 7: education - financing options
  { type: 'question', canProceed: (d) => !!d.first_name && !!d.phone && d.phone.replace(/\D/g, '').length >= 7 }, // 8: contact
]

const TOTAL_STEPS = STEP_CONFIG.length

// =============================================
// REUSABLE COMPONENTS
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
          <div className="flex-1">
            <p className={cn('font-semibold text-sm', value === opt.value ? 'text-blue-900' : 'text-gray-900')}>
              {opt.label}
            </p>
            {opt.desc && <p className={cn('text-xs mt-0.5', value === opt.value ? 'text-blue-700' : 'text-gray-500')}>{opt.desc}</p>}
          </div>
          <div className={cn(
            'mt-1 h-5 w-5 rounded-full border-2 shrink-0 flex items-center justify-center',
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

function YesNoSelector({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-3">
      {['yes', 'no'].map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            'flex-1 rounded-xl border-2 py-3 text-sm font-semibold transition-all',
            value === v
              ? 'border-blue-600 bg-blue-50 text-blue-700'
              : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
          )}
        >
          {v === 'yes' ? 'Yes' : 'No'}
        </button>
      ))}
    </div>
  )
}

function EducationCard({ icon, title, points, highlight }: {
  icon: string
  title: string
  points: string[]
  highlight?: string
}) {
  return (
    <div className="rounded-2xl bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100 p-6">
      <div className="text-4xl mb-4">{icon}</div>
      <h3 className="text-xl font-bold text-gray-900 mb-4">{title}</h3>
      <ul className="space-y-3">
        {points.map((point, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold shrink-0 mt-0.5">
              {i + 1}
            </span>
            <span className="text-sm text-gray-700">{point}</span>
          </li>
        ))}
      </ul>
      {highlight && (
        <div className="mt-5 rounded-xl bg-white border border-blue-200 p-4">
          <p className="text-sm font-medium text-blue-800">{highlight}</p>
        </div>
      )}
    </div>
  )
}

// =============================================
// STEP 1: TEETH SITUATION
// =============================================
function Step1Teeth({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          Let&apos;s start with your current smile situation
        </h2>
        <p className="text-gray-500 mb-6">Select the option that best describes you.</p>
        <CardSelector
          options={[
            { value: 'no_teeth', label: 'I have no teeth (or very few)', icon: '😟', desc: 'Missing all or nearly all teeth' },
            { value: 'failing_teeth', label: 'My teeth are failing', icon: '🦷', desc: 'Broken, decayed, or need extractions' },
            { value: 'dentures', label: 'I wear dentures', icon: '😤', desc: "They're loose, painful, or I hate them" },
            { value: 'some_missing', label: 'I have some missing teeth', icon: '😬', desc: 'Multiple gaps, hard to eat or smile' },
            { value: 'not_sure', label: "I'm not sure what I need", icon: '🤔', desc: 'I want an expert opinion' },
          ]}
          value={data.teeth_situation}
          onChange={(v) => update('teeth_situation', v)}
        />
      </div>

      {data.teeth_situation && (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              How many natural teeth do you have remaining on top? (Upper arch)
            </label>
            <CardSelector
              options={[
                { value: 'none', label: 'None — no teeth', icon: '0' },
                { value: '1_5', label: '1 to 5 teeth' },
                { value: '6_10', label: '6 to 10 teeth' },
                { value: '10_plus', label: 'More than 10' },
                { value: 'not_sure_upper', label: "I'm not sure" },
              ]}
              value={data.teeth_count_upper}
              onChange={(v) => update('teeth_count_upper', v)}
              columns={1}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              How about on the bottom? (Lower arch)
            </label>
            <CardSelector
              options={[
                { value: 'none', label: 'None — no teeth', icon: '0' },
                { value: '1_5', label: '1 to 5 teeth' },
                { value: '6_10', label: '6 to 10 teeth' },
                { value: '10_plus', label: 'More than 10' },
                { value: 'not_sure_lower', label: "I'm not sure" },
              ]}
              value={data.teeth_count_lower}
              onChange={(v) => update('teeth_count_lower', v)}
              columns={1}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              Do you currently wear dentures or partials?
            </label>
            <CardSelector
              options={[
                { value: 'full_dentures', label: 'Full dentures (top, bottom, or both)', icon: '🔄' },
                { value: 'partial_dentures', label: 'Partial dentures', icon: '↔️' },
                { value: 'no_dentures', label: "No, I don't wear any", icon: '✖️' },
              ]}
              value={data.has_dentures}
              onChange={(v) => update('has_dentures', v)}
              columns={1}
            />
          </div>
        </>
      )}
    </div>
  )
}

// =============================================
// STEP 2: EDUCATION — WHAT IS ALL-ON-4
// =============================================
function Step2Education() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        You could be a great candidate for All-on-4 dental implants
      </h2>
      <p className="text-gray-500 mb-4">Here&apos;s what you need to know:</p>
      <EducationCard
        icon="✨"
        title="What are All-on-4 Implants?"
        points={[
          'A full arch of beautiful, permanent teeth — fixed to just 4 implants per jaw',
          'You walk in with missing or failing teeth and walk out the same day with a brand-new smile',
          'They look, feel, and function like natural teeth — eat anything you want',
          'No more denture adhesive, no more slipping, no more embarrassment',
        ]}
        highlight="Over 98% success rate — this is the gold standard in modern tooth replacement."
      />
      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="rounded-xl bg-white border border-gray-200 p-4">
          <div className="text-2xl font-bold text-blue-600">1 Day</div>
          <div className="text-xs text-gray-500 mt-1">New Teeth Same Day</div>
        </div>
        <div className="rounded-xl bg-white border border-gray-200 p-4">
          <div className="text-2xl font-bold text-blue-600">20+ yrs</div>
          <div className="text-xs text-gray-500 mt-1">Average Lifespan</div>
        </div>
        <div className="rounded-xl bg-white border border-gray-200 p-4">
          <div className="text-2xl font-bold text-blue-600">98%+</div>
          <div className="text-xs text-gray-500 mt-1">Success Rate</div>
        </div>
      </div>
    </div>
  )
}

// =============================================
// STEP 3: PREVIOUS CONSULTATIONS
// =============================================
function Step3PrevConsults({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        Have you consulted with other dental implant providers?
      </h2>
      <p className="text-gray-500 mb-4">This helps us understand where you are in your journey.</p>

      <CardSelector
        options={[
          { value: 'yes_multiple', label: "Yes, I've seen multiple doctors", icon: '🏥', desc: "I've been shopping around and comparing" },
          { value: 'yes_one', label: "Yes, I've had one consultation", icon: '👨‍⚕️', desc: 'I got a quote but haven\'t decided' },
          { value: 'no_first', label: 'No, this is my first step', icon: '👋', desc: "I'm just starting to explore options" },
        ]}
        value={data.previous_consults}
        onChange={(v) => update('previous_consults', v)}
        columns={1}
      />

      {(data.previous_consults === 'yes_multiple' || data.previous_consults === 'yes_one') && (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Where did you consult? (e.g., ClearChoice, Affordable Dentures, local office)
            </label>
            <input
              value={data.previous_consult_locations}
              onChange={(e) => update('previous_consult_locations', e.target.value)}
              placeholder="ClearChoice, Dr. Smith's office, etc."
              className="w-full rounded-xl border-2 border-gray-200 px-4 py-3 text-sm focus:border-blue-600 focus:ring-1 focus:ring-blue-600 outline-none transition-colors"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-3">
              What held you back from moving forward?
            </label>
            <CardSelector
              options={[
                { value: 'too_expensive', label: 'Price was too high', icon: '💸' },
                { value: 'not_confident', label: "Didn't feel confident in the doctor", icon: '😕' },
                { value: 'need_time', label: 'Needed more time to decide', icon: '⏳' },
                { value: 'financing_denied', label: "Couldn't get approved for financing", icon: '🚫' },
                { value: 'fear', label: 'Nervous about the procedure', icon: '😰' },
                { value: 'other_reason', label: 'Something else', icon: '💭' },
              ]}
              value={data.what_held_back}
              onChange={(v) => update('what_held_back', v)}
            />
          </div>
        </>
      )}
    </div>
  )
}

// =============================================
// STEP 4: EDUCATION — THE PROCESS
// =============================================
function Step4Education() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        Here&apos;s how the process actually works
      </h2>
      <p className="text-gray-500 mb-4">It&apos;s simpler than most people think:</p>
      <EducationCard
        icon="🗓️"
        title="Your Journey to a New Smile"
        points={[
          'Free consultation — CT scan, smile design, and personalized treatment plan (no obligation)',
          'If you qualify, treatment can begin right away. Sedation options available for comfort.',
          'Temporary teeth placed same day — you leave with a functional, beautiful smile',
          'Final custom prosthesis delivered in 3-6 months — your permanent, gorgeous teeth',
        ]}
        highlight="Most patients say they wish they'd done it years ago. The biggest regret? Not doing it sooner."
      />
      <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
        <p className="text-sm text-amber-800">
          <strong>Concerned about pain?</strong> Most patients report less discomfort than a tooth extraction.
          IV sedation means you sleep through the entire procedure.
        </p>
      </div>
    </div>
  )
}

// =============================================
// STEP 5: URGENCY + PAIN
// =============================================
function Step5Urgency({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        How soon are you looking to get this done?
      </h2>
      <p className="text-gray-500 mb-4">No wrong answer — we work on your timeline.</p>

      <CardSelector
        options={[
          { value: 'asap', label: "As soon as possible", icon: '🔥', desc: "I'm ready to move forward now" },
          { value: '1_3_months', label: 'Within 1-3 months', icon: '📅', desc: "I'm seriously looking and want to start soon" },
          { value: '3_6_months', label: '3-6 months', icon: '🗓️', desc: "I'm planning and researching" },
          { value: 'not_sure', label: 'Not sure yet', icon: '🤔', desc: 'It depends on cost and fit' },
        ]}
        value={data.urgency}
        onChange={(v) => update('urgency', v)}
        columns={1}
      />

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-3">
          Are you currently in pain or discomfort?
        </label>
        <CardSelector
          options={[
            { value: 'severe_pain', label: "Yes, significant pain daily", icon: '😣', desc: 'It affects my eating, sleeping, or daily life' },
            { value: 'moderate_pain', label: 'Some discomfort', icon: '😐', desc: 'Manageable but annoying' },
            { value: 'no_pain', label: 'No pain right now', icon: '😊', desc: "It's more about function or appearance" },
            { value: 'embarrassment', label: "Mostly embarrassment", icon: '🫣', desc: "I avoid smiling and social situations" },
          ]}
          value={data.pain_level}
          onChange={(v) => update('pain_level', v)}
          columns={1}
        />
      </div>
    </div>
  )
}

// =============================================
// STEP 6: CREDIT + FINANCING
// =============================================
function Step6Financing({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        Let&apos;s talk about making this affordable
      </h2>
      <p className="text-gray-500 mb-4">
        Most patients use financing. We work with top lenders to find the right plan for you.
      </p>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-3">
          What&apos;s your estimated credit score range?
        </label>
        <CardSelector
          options={[
            { value: '720_plus', label: 'Excellent (720+)', icon: '🌟', desc: 'Best rates, most options available' },
            { value: '680_719', label: 'Good (680-719)', icon: '👍', desc: 'Great options available' },
            { value: '600_679', label: 'Fair (600-679)', icon: '📊', desc: 'Multiple financing programs available' },
            { value: 'below_600', label: 'Below 600', icon: '📋', desc: 'We have programs that can help' },
            { value: 'not_sure_credit', label: "I'm not sure", icon: '❓', desc: "That's okay — we can help you find out" },
          ]}
          value={data.credit_score_range}
          onChange={(v) => update('credit_score_range', v)}
          columns={1}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-3">
          What monthly payment would be comfortable for you?
        </label>
        <CardSelector
          options={[
            { value: 'under_200', label: 'Under $200/month', icon: '💵' },
            { value: '200_350', label: '$200 - $350/month', icon: '💰' },
            { value: '350_500', label: '$350 - $500/month', icon: '💰💰' },
            { value: '500_plus', label: '$500+/month or cash pay', icon: '💎' },
            { value: 'need_to_discuss', label: 'I need to discuss options', icon: '💬' },
          ]}
          value={data.monthly_payment_range}
          onChange={(v) => update('monthly_payment_range', v)}
          columns={1}
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-3">
          Would you have a co-signer available if needed?
        </label>
        <p className="text-xs text-gray-400 mb-3">A co-signer (spouse, family member) can help with approval and lower rates.</p>
        <CardSelector
          options={[
            { value: 'yes_cosigner', label: 'Yes, I have someone who can co-sign', icon: '✅' },
            { value: 'maybe_cosigner', label: 'Maybe — I\'d need to ask', icon: '🤷' },
            { value: 'no_cosigner', label: 'No, it would just be me', icon: '👤' },
            { value: 'cash_no_need', label: "I'm paying cash — no financing needed", icon: '💰' },
          ]}
          value={data.has_cosigner}
          onChange={(v) => update('has_cosigner', v)}
          columns={1}
        />
      </div>
    </div>
  )
}

// =============================================
// STEP 7: EDUCATION — FINANCING OPTIONS
// =============================================
function Step7Education() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        Great news — most patients get approved
      </h2>
      <p className="text-gray-500 mb-4">We offer multiple financing paths:</p>
      <EducationCard
        icon="💳"
        title="Flexible Financing Options"
        points={[
          '0% interest plans available for qualified patients — pay over 12-24 months with no interest',
          'Extended plans up to 60 months — payments as low as $199/month',
          'Multiple lender network — if one says no, we try others. Over 85% approval rate.',
          'No penalty for early payoff — pay it off whenever you want',
        ]}
        highlight="We've helped patients with credit scores as low as 550 get approved. Don't let finances stop you from smiling."
      />
      <div className="grid grid-cols-2 gap-3 text-center">
        <div className="rounded-xl bg-white border border-gray-200 p-4">
          <div className="text-2xl font-bold text-green-600">85%+</div>
          <div className="text-xs text-gray-500 mt-1">Approval Rate</div>
        </div>
        <div className="rounded-xl bg-white border border-gray-200 p-4">
          <div className="text-2xl font-bold text-green-600">$199</div>
          <div className="text-xs text-gray-500 mt-1">Payments As Low As</div>
        </div>
      </div>
    </div>
  )
}

// =============================================
// STEP 8: CONTACT INFO
// =============================================
function Step8Contact({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-2">
        Last step — let&apos;s get you scheduled!
      </h2>
      <p className="text-gray-500 mb-6">
        We&apos;ll reach out to set up your free, no-obligation consultation with the doctor.
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
        <div className="rounded-xl bg-green-50 border border-green-200 p-4 mt-4">
          <div className="flex items-start gap-3">
            <span className="text-xl">🔒</span>
            <div>
              <p className="text-sm font-medium text-green-800">Your privacy is protected</p>
              <p className="text-xs text-green-600 mt-0.5">
                We never share your information. This is between you and the doctor.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// =============================================
// SUCCESS / RESULTS
// =============================================
function StepSuccess({ score, data }: { score: ScoreResult; data: FormData }) {
  const qual = score?.qualification || 'warm'
  const msgs: Record<string, { title: string; desc: string; color: string; bg: string }> = {
    hot: {
      title: "Fantastic — you're an excellent candidate!",
      desc: "Based on everything you've shared, you're a strong fit for All-on-4 implants. We're excited to help you get your new smile.",
      color: 'text-green-700', bg: 'bg-green-50 border-green-200',
    },
    warm: {
      title: "Great news — you could be a strong candidate!",
      desc: "The doctor would love to meet you for a free consultation to create your personalized treatment plan.",
      color: 'text-blue-700', bg: 'bg-blue-50 border-blue-200',
    },
    cold: {
      title: "Thank you for taking the assessment!",
      desc: "A consultation with the doctor will help determine the best treatment options for your unique situation.",
      color: 'text-indigo-700', bg: 'bg-indigo-50 border-indigo-200',
    },
    unqualified: {
      title: "Thanks for your interest!",
      desc: "We'll review your information and reach out to discuss what options may be available for you.",
      color: 'text-gray-700', bg: 'bg-gray-50 border-gray-200',
    },
  }
  const m = msgs[qual] || msgs.warm

  return (
    <div className="text-center">
      <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-100 mb-6">
        <svg className="w-10 h-10 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h2 className={cn('text-2xl font-bold mb-3', m.color)}>{m.title}</h2>
      <div className={cn('rounded-xl border-2 p-5 mb-6', m.bg)}>
        <p className="text-sm text-gray-700">{m.desc}</p>
        {score && (
          <div className="mt-4">
            <div className="text-3xl font-bold text-gray-900">{score.total}<span className="text-lg text-gray-400">/100</span></div>
            <div className="text-xs text-gray-500">Candidate Match Score</div>
          </div>
        )}
      </div>
      <p className="text-gray-600 text-sm mb-6">
        {data.first_name}, expect a call or text within 24 hours at <strong>{data.phone}</strong> to schedule your free consultation.
      </p>
      <div className="rounded-xl bg-gray-50 border border-gray-200 p-4 text-left">
        <p className="text-xs text-gray-500 font-medium uppercase tracking-wider mb-3">What&apos;s next</p>
        <div className="space-y-2.5 text-sm text-gray-600">
          {['We review your assessment and match you with the right doctor', 'You\'ll receive a call/text to schedule your FREE consultation', 'Meet the doctor, get a CT scan, and see your custom smile design', 'If you decide to move forward, treatment can start the same week'].map((t, i) => (
            <div key={i} className="flex items-start gap-2.5">
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-xs font-bold shrink-0 mt-0.5">{i + 1}</span>
              <span>{t}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// =============================================
// PROGRESS BAR
// =============================================
function ProgressBar({ current, total }: { current: number; total: number }) {
  const questionSteps = STEP_CONFIG.filter((s) => s.type === 'question').length
  const currentQuestion = STEP_CONFIG.slice(0, current).filter((s) => s.type === 'question').length + (STEP_CONFIG[current - 1]?.type === 'question' ? 0 : 0)
  return (
    <div className="mb-8">
      <div className="flex justify-between text-xs text-gray-400 mb-2">
        <span>Step {current} of {total}</span>
        <span>{Math.round((current / total) * 100)}%</span>
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
  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [score, setScore] = useState<ScoreResult>(null)

  const [data, setData] = useState<FormData>({
    teeth_situation: '', teeth_count_upper: '', teeth_count_lower: '', has_dentures: '',
    previous_consults: '', previous_consult_locations: '', what_held_back: '',
    urgency: '', pain_level: '',
    credit_score_range: '', monthly_payment_range: '', has_cosigner: '', financing_interest: '',
    first_name: '', last_name: '', phone: '', email: '', city: '', state: '',
  })

  const update = useCallback((field: keyof FormData, value: string) => {
    setData((prev) => ({ ...prev, [field]: value }))
  }, [])

  const currentConfig = STEP_CONFIG[step - 1]
  const canProceed = currentConfig?.canProceed(data) ?? false

  // Map teeth_situation to dental_condition for the API
  function mapDentalCondition(): string {
    const m: Record<string, string> = {
      no_teeth: 'missing_all_both', failing_teeth: 'failing_teeth',
      dentures: 'denture_problems', some_missing: 'missing_multiple', not_sure: 'other',
    }
    return m[data.teeth_situation] || 'other'
  }

  // Map financing fields
  function mapFinancingInterest(): string {
    if (data.has_cosigner === 'cash_no_need') return 'cash_pay'
    if (data.monthly_payment_range === '500_plus') return 'cash_pay'
    return 'financing_needed'
  }

  async function handleSubmit() {
    setSubmitting(true)
    try {
      const payload = {
        first_name: data.first_name,
        last_name: data.last_name || undefined,
        phone: data.phone,
        email: data.email || undefined,
        city: data.city || undefined,
        state: data.state || undefined,
        dental_condition: mapDentalCondition(),
        dental_condition_details: [
          `Teeth situation: ${data.teeth_situation}`,
          `Upper teeth: ${data.teeth_count_upper}`,
          `Lower teeth: ${data.teeth_count_lower}`,
          `Dentures: ${data.has_dentures}`,
          data.previous_consults !== 'no_first' ? `Previous consults: ${data.previous_consult_locations || data.previous_consults}` : '',
          data.what_held_back ? `What held back: ${data.what_held_back}` : '',
          `Pain level: ${data.pain_level}`,
          `Credit range: ${data.credit_score_range}`,
          `Monthly payment: ${data.monthly_payment_range}`,
          `Co-signer: ${data.has_cosigner}`,
        ].filter(Boolean).join(' | '),
        has_dentures: data.has_dentures.includes('denture'),
        urgency: data.urgency,
        financing_interest: mapFinancingInterest(),
        has_dental_insurance: false,
        budget_range: data.monthly_payment_range === '500_plus' ? 'over_30k' :
          data.monthly_payment_range === '350_500' ? '20k_25k' :
          data.monthly_payment_range === '200_350' ? '15k_20k' : '10k_15k',
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

      const res = await fetch(`${apiBase}/api/webhooks/qualify?org=${orgId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) throw new Error('Submission failed')
      const result = await res.json()
      setScore(result.score)
      setSubmitted(true)

      if (typeof window !== 'undefined') {
        if ((window as any).gtag) (window as any).gtag('event', 'conversion', { send_to: 'lead_qualification_complete' })
        if ((window as any).fbq) (window as any).fbq('track', 'Lead')
      }
    } catch {
      alert('Something went wrong. Please try again or call us directly.')
    } finally {
      setSubmitting(false)
    }
  }

  function next() {
    if (step === TOTAL_STEPS) handleSubmit()
    else setStep((s) => s + 1)
  }

  function back() {
    setStep((s) => Math.max(1, s - 1))
  }

  if (submitted) {
    return (
      <div className="max-w-lg mx-auto px-4 py-8">
        <StepSuccess score={score} data={data} />
      </div>
    )
  }

  return (
    <div className="max-w-lg mx-auto px-4 py-6">
      <ProgressBar current={step} total={TOTAL_STEPS} />

      <div className="min-h-[420px]">
        {step === 1 && <Step1Teeth data={data} update={update} />}
        {step === 2 && <Step2Education />}
        {step === 3 && <Step3PrevConsults data={data} update={update} />}
        {step === 4 && <Step4Education />}
        {step === 5 && <Step5Urgency data={data} update={update} />}
        {step === 6 && <Step6Financing data={data} update={update} />}
        {step === 7 && <Step7Education />}
        {step === 8 && <Step8Contact data={data} update={update} />}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between mt-8">
        {step > 1 ? (
          <button type="button" onClick={back} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            Back
          </button>
        ) : <div />}

        <button
          type="button"
          onClick={next}
          disabled={!canProceed || submitting}
          className={cn(
            'flex items-center gap-2 rounded-xl px-8 py-3.5 text-sm font-semibold transition-all',
            canProceed && !submitting
              ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-600/25 hover:shadow-xl'
              : 'bg-gray-200 text-gray-400 cursor-not-allowed'
          )}
        >
          {submitting ? (
            <>
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              Analyzing your results...
            </>
          ) : step === TOTAL_STEPS ? (
            'Get My Results →'
          ) : currentConfig?.type === 'education' ? (
            <>
              Got it, continue
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </>
          ) : (
            <>
              Continue
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </>
          )}
        </button>
      </div>
    </div>
  )
}
