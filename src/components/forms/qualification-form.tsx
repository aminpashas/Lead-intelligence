'use client'

import { useState, useCallback } from 'react'

// =============================================
// TYPES
// =============================================
type FormData = {
  teeth_situation: string
  teeth_count_upper: string
  teeth_count_lower: string
  has_dentures: string
  previous_consults: string
  previous_consult_locations: string
  what_held_back: string
  urgency: string
  pain_level: string
  credit_score_range: string
  monthly_payment_range: string
  has_cosigner: string
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
  { type: 'question', canProceed: (d) => !!d.teeth_situation },
  { type: 'education', canProceed: () => true },
  { type: 'question', canProceed: (d) => !!d.previous_consults },
  { type: 'education', canProceed: () => true },
  { type: 'question', canProceed: (d) => !!d.urgency && !!d.pain_level },
  { type: 'question', canProceed: (d) => !!d.credit_score_range && !!d.monthly_payment_range },
  { type: 'education', canProceed: () => true },
  { type: 'question', canProceed: (d) => !!d.first_name && !!d.phone && d.phone.replace(/\D/g, '').length >= 7 },
]

const TOTAL_STEPS = STEP_CONFIG.length

// =============================================
// STYLES — warm, accessible, large touch targets
// =============================================
const styles = {
  heading: 'text-2xl sm:text-3xl font-bold text-[#2d2926] leading-tight',
  subtext: 'text-base sm:text-lg text-[#6b5e54] leading-relaxed mt-2',
  label: 'block text-base font-semibold text-[#3d3530] mb-3',
  card: (selected: boolean) => [
    'w-full flex items-center gap-4 rounded-2xl border-2 p-5 text-left transition-all cursor-pointer',
    selected
      ? 'border-[#c17f3e] bg-[#fdf6ee] shadow-md'
      : 'border-[#e8ddd0] bg-white hover:border-[#d4c4ad] hover:bg-[#fefcf9]',
  ].join(' '),
  cardIcon: 'text-3xl shrink-0',
  cardLabel: (selected: boolean) => `text-base font-semibold ${selected ? 'text-[#8b5e2f]' : 'text-[#3d3530]'}`,
  cardDesc: (selected: boolean) => `text-sm mt-0.5 ${selected ? 'text-[#a07640]' : 'text-[#8a7d72]'}`,
  check: (selected: boolean) => [
    'ml-auto h-6 w-6 rounded-full border-2 shrink-0 flex items-center justify-center transition-colors',
    selected ? 'border-[#c17f3e] bg-[#c17f3e]' : 'border-[#d4c4ad]',
  ].join(' '),
  input: 'w-full rounded-2xl border-2 border-[#e8ddd0] bg-white px-5 py-4 text-base text-[#3d3530] placeholder-[#b5a99a] focus:border-[#c17f3e] focus:ring-2 focus:ring-[#c17f3e]/20 outline-none transition-colors',
  btnPrimary: (enabled: boolean) => [
    'flex items-center justify-center gap-2 rounded-2xl px-10 py-4 text-base font-bold transition-all w-full sm:w-auto',
    enabled
      ? 'bg-[#c17f3e] text-white hover:bg-[#a96b2e] shadow-lg shadow-[#c17f3e]/20'
      : 'bg-[#e8ddd0] text-[#b5a99a] cursor-not-allowed',
  ].join(' '),
  btnBack: 'flex items-center gap-1 text-base text-[#8a7d72] hover:text-[#5a4f45] transition-colors',
  eduCard: 'rounded-2xl bg-[#fdf6ee] border-2 border-[#edd9be] p-6 sm:p-8',
  eduTitle: 'text-xl sm:text-2xl font-bold text-[#3d3530] mb-5',
  eduPoint: 'flex items-start gap-4 mb-4',
  eduNum: 'inline-flex items-center justify-center w-8 h-8 rounded-full bg-[#c17f3e] text-white text-sm font-bold shrink-0 mt-0.5',
  eduText: 'text-base text-[#5a4f45] leading-relaxed',
  highlight: 'mt-6 rounded-2xl bg-white border-2 border-[#c17f3e]/30 p-5',
  highlightText: 'text-base font-semibold text-[#8b5e2f]',
  stat: 'rounded-2xl bg-white border-2 border-[#e8ddd0] p-5 text-center',
  statNum: 'text-3xl font-bold text-[#c17f3e]',
  statLabel: 'text-sm text-[#8a7d72] mt-1',
}

// =============================================
// CARD SELECTOR
// =============================================
function CardSelector({
  options, value, onChange,
}: {
  options: Array<{ value: string; label: string; icon?: string; desc?: string }>
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="space-y-3">
      {options.map((opt) => (
        <button key={opt.value} type="button" onClick={() => onChange(opt.value)} className={styles.card(value === opt.value)}>
          {opt.icon && <span className={styles.cardIcon}>{opt.icon}</span>}
          <div className="flex-1 min-w-0">
            <p className={styles.cardLabel(value === opt.value)}>{opt.label}</p>
            {opt.desc && <p className={styles.cardDesc(value === opt.value)}>{opt.desc}</p>}
          </div>
          <div className={styles.check(value === opt.value)}>
            {value === opt.value && (
              <svg className="h-3.5 w-3.5 text-white" fill="currentColor" viewBox="0 0 12 12">
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
// STEP 1: TEETH
// =============================================
function Step1({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div className="space-y-8">
      <div>
        <h2 className={styles.heading}>Let&apos;s start with your teeth</h2>
        <p className={styles.subtext}>Which of these sounds most like you?</p>
      </div>

      <CardSelector
        options={[
          { value: 'no_teeth', label: 'I have no teeth left (or almost none)', icon: '😔' },
          { value: 'failing_teeth', label: 'My teeth are breaking down and need to come out', icon: '😣' },
          { value: 'dentures', label: 'I wear dentures and I hate them', icon: '😤', desc: 'They slip, hurt, or make it hard to eat' },
          { value: 'some_missing', label: 'I\'m missing several teeth', icon: '😕', desc: 'It\'s hard to eat or I\'m embarrassed to smile' },
          { value: 'not_sure', label: 'I\'m not sure — I just want to smile again', icon: '🙂' },
        ]}
        value={data.teeth_situation}
        onChange={(v) => update('teeth_situation', v)}
      />

      {data.teeth_situation && (
        <div className="space-y-8 pt-2">
          <div>
            <p className={styles.label}>How many natural teeth do you still have on top?</p>
            <CardSelector
              options={[
                { value: 'none', label: 'None at all' },
                { value: '1_5', label: 'A few (1 to 5)' },
                { value: '6_10', label: 'About half (6 to 10)' },
                { value: '10_plus', label: 'Most of them (10+)' },
                { value: 'not_sure_upper', label: 'Not sure' },
              ]}
              value={data.teeth_count_upper}
              onChange={(v) => update('teeth_count_upper', v)}
            />
          </div>

          <div>
            <p className={styles.label}>And on the bottom?</p>
            <CardSelector
              options={[
                { value: 'none', label: 'None at all' },
                { value: '1_5', label: 'A few (1 to 5)' },
                { value: '6_10', label: 'About half (6 to 10)' },
                { value: '10_plus', label: 'Most of them (10+)' },
                { value: 'not_sure_lower', label: 'Not sure' },
              ]}
              value={data.teeth_count_lower}
              onChange={(v) => update('teeth_count_lower', v)}
            />
          </div>

          <div>
            <p className={styles.label}>Do you wear dentures or partials right now?</p>
            <CardSelector
              options={[
                { value: 'full_dentures', label: 'Yes — full dentures' },
                { value: 'partial_dentures', label: 'Yes — partial dentures' },
                { value: 'no_dentures', label: 'No' },
              ]}
              value={data.has_dentures}
              onChange={(v) => update('has_dentures', v)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// =============================================
// STEP 2: EDUCATION
// =============================================
function Step2() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className={styles.heading}>There&apos;s a better way to live</h2>
        <p className={styles.subtext}>
          Thousands of people just like you have gotten their smile — and their life — back.
        </p>
      </div>

      <div className={styles.eduCard}>
        <h3 className={styles.eduTitle}>What are permanent implant teeth?</h3>
        <div className={styles.eduPoint}>
          <span className={styles.eduNum}>1</span>
          <span className={styles.eduText}>Beautiful new teeth are placed on 4 small implants — <strong>in one visit</strong></span>
        </div>
        <div className={styles.eduPoint}>
          <span className={styles.eduNum}>2</span>
          <span className={styles.eduText}>They <strong>don&apos;t come out</strong>. No adhesive. No slipping. Ever.</span>
        </div>
        <div className={styles.eduPoint}>
          <span className={styles.eduNum}>3</span>
          <span className={styles.eduText}>You can <strong>eat steak, apples, corn on the cob</strong> — anything you want</span>
        </div>
        <div className={styles.eduPoint}>
          <span className={styles.eduNum}>4</span>
          <span className={styles.eduText}>They last <strong>20+ years</strong> and look completely natural</span>
        </div>
        <div className={styles.highlight}>
          <p className={styles.highlightText}>
            &quot;I can finally eat at a restaurant without worrying. I wish I&apos;d done this 10 years ago.&quot;
          </p>
          <p className="text-sm text-[#8a7d72] mt-2">— Real patient, age 67</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className={styles.stat}>
          <div className={styles.statNum}>1 Day</div>
          <div className={styles.statLabel}>New Smile</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statNum}>20+ yr</div>
          <div className={styles.statLabel}>They Last</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statNum}>98%</div>
          <div className={styles.statLabel}>Success</div>
        </div>
      </div>
    </div>
  )
}

// =============================================
// STEP 3: PREVIOUS CONSULTS
// =============================================
function Step3({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div className="space-y-8">
      <div>
        <h2 className={styles.heading}>Have you looked into this before?</h2>
        <p className={styles.subtext}>No judgment — many people shop around. We just want to help you get to the finish line.</p>
      </div>

      <CardSelector
        options={[
          { value: 'yes_multiple', label: 'Yes, I\'ve been to a few places', icon: '🏥', desc: 'Still trying to find the right fit' },
          { value: 'yes_one', label: 'Yes, I had one consultation', icon: '👨‍⚕️', desc: 'But I didn\'t move forward yet' },
          { value: 'no_first', label: 'No, this is my first time looking', icon: '👋', desc: 'I\'m just getting started' },
        ]}
        value={data.previous_consults}
        onChange={(v) => update('previous_consults', v)}
      />

      {(data.previous_consults === 'yes_multiple' || data.previous_consults === 'yes_one') && (
        <div className="space-y-6">
          <div>
            <p className={styles.label}>Where did you go?</p>
            <input
              value={data.previous_consult_locations}
              onChange={(e) => update('previous_consult_locations', e.target.value)}
              placeholder="ClearChoice, Affordable Dentures, a local dentist..."
              className={styles.input}
            />
          </div>

          <div>
            <p className={styles.label}>What stopped you from moving forward?</p>
            <CardSelector
              options={[
                { value: 'too_expensive', label: 'It was too expensive', icon: '💸' },
                { value: 'financing_denied', label: 'I couldn\'t get approved for payments', icon: '🚫' },
                { value: 'not_confident', label: 'I didn\'t feel comfortable with the doctor', icon: '😕' },
                { value: 'need_time', label: 'I needed more time to think', icon: '⏳' },
                { value: 'fear', label: 'I\'m nervous about the procedure', icon: '😰' },
                { value: 'other_reason', label: 'Something else', icon: '💭' },
              ]}
              value={data.what_held_back}
              onChange={(v) => update('what_held_back', v)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// =============================================
// STEP 4: EDUCATION — PROCESS
// =============================================
function Step4() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className={styles.heading}>Here&apos;s exactly what happens</h2>
        <p className={styles.subtext}>No surprises. We walk with you every step of the way.</p>
      </div>

      <div className={styles.eduCard}>
        <h3 className={styles.eduTitle}>Your path to new teeth</h3>
        <div className={styles.eduPoint}>
          <span className={styles.eduNum}>1</span>
          <span className={styles.eduText}><strong>Free consultation</strong> — the doctor looks at your mouth, takes a scan, and designs your new smile. No cost, no pressure.</span>
        </div>
        <div className={styles.eduPoint}>
          <span className={styles.eduNum}>2</span>
          <span className={styles.eduText}><strong>Treatment day</strong> — you&apos;re comfortably sedated (you sleep through it). Old teeth come out, implants go in, new teeth are placed. <strong>All in one day.</strong></span>
        </div>
        <div className={styles.eduPoint}>
          <span className={styles.eduNum}>3</span>
          <span className={styles.eduText}><strong>Healing period</strong> — you go home with beautiful temporary teeth. Soft foods for a few weeks while everything heals.</span>
        </div>
        <div className={styles.eduPoint}>
          <span className={styles.eduNum}>4</span>
          <span className={styles.eduText}><strong>Final teeth</strong> — after 3-6 months, your permanent custom teeth are placed. These are yours for life.</span>
        </div>
      </div>

      <div className="rounded-2xl bg-[#f0f7f0] border-2 border-[#c5dfc5] p-5">
        <p className="text-base text-[#3a5a3a]">
          <strong>Worried about pain?</strong> Most patients say it was easier than getting a tooth pulled. You sleep through the whole thing.
        </p>
      </div>
    </div>
  )
}

// =============================================
// STEP 5: URGENCY + PAIN
// =============================================
function Step5({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div className="space-y-8">
      <div>
        <h2 className={styles.heading}>How are you feeling right now?</h2>
        <p className={styles.subtext}>This helps us know how quickly we should get you in.</p>
      </div>

      <div>
        <p className={styles.label}>Are you dealing with any pain or discomfort?</p>
        <CardSelector
          options={[
            { value: 'severe_pain', label: 'Yes — it hurts every day', icon: '😣', desc: 'Hard to eat, sleep, or enjoy life' },
            { value: 'moderate_pain', label: 'Some discomfort, but I manage', icon: '😐' },
            { value: 'embarrassment', label: 'No pain, but I\'m embarrassed to smile', icon: '🫣', desc: 'I cover my mouth or avoid photos' },
            { value: 'no_pain', label: 'No pain — I just want better teeth', icon: '😊' },
          ]}
          value={data.pain_level}
          onChange={(v) => update('pain_level', v)}
        />
      </div>

      <div>
        <p className={styles.label}>How soon would you like to get started?</p>
        <CardSelector
          options={[
            { value: 'asap', label: 'Right away — I\'m ready', icon: '🙋' },
            { value: '1_3_months', label: 'In the next couple months', icon: '📅' },
            { value: '3_6_months', label: 'Later this year', icon: '🗓️' },
            { value: 'not_sure', label: 'Depends on cost', icon: '🤔' },
          ]}
          value={data.urgency}
          onChange={(v) => update('urgency', v)}
        />
      </div>
    </div>
  )
}

// =============================================
// STEP 6: FINANCING
// =============================================
function Step6({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div className="space-y-8">
      <div>
        <h2 className={styles.heading}>Let&apos;s make sure this fits your budget</h2>
        <p className={styles.subtext}>Most people use a payment plan. We&apos;ll find what works for you.</p>
      </div>

      <div>
        <p className={styles.label}>What&apos;s your credit score range? (It&apos;s okay if you&apos;re not sure)</p>
        <CardSelector
          options={[
            { value: '720_plus', label: 'Excellent — 720 or above', desc: 'You\'ll qualify for the best rates' },
            { value: '680_719', label: 'Good — 680 to 719', desc: 'Plenty of great options' },
            { value: '600_679', label: 'Fair — 600 to 679', desc: 'We have programs that work' },
            { value: 'below_600', label: 'Below 600', desc: 'Don\'t worry — we still have options' },
            { value: 'not_sure_credit', label: 'I honestly don\'t know', desc: 'That\'s fine — we can help figure it out' },
          ]}
          value={data.credit_score_range}
          onChange={(v) => update('credit_score_range', v)}
        />
      </div>

      <div>
        <p className={styles.label}>What monthly payment would feel comfortable?</p>
        <CardSelector
          options={[
            { value: 'under_200', label: 'Under $200 a month' },
            { value: '200_350', label: '$200 to $350 a month' },
            { value: '350_500', label: '$350 to $500 a month' },
            { value: '500_plus', label: '$500+ a month or paying in full' },
            { value: 'need_to_discuss', label: 'I need help figuring this out' },
          ]}
          value={data.monthly_payment_range}
          onChange={(v) => update('monthly_payment_range', v)}
        />
      </div>

      <div>
        <p className={styles.label}>Could a family member co-sign if needed?</p>
        <p className="text-sm text-[#8a7d72] mb-3">A spouse or adult child co-signing can help with approval and lower your rate.</p>
        <CardSelector
          options={[
            { value: 'yes_cosigner', label: 'Yes, someone can help' },
            { value: 'maybe_cosigner', label: 'Maybe — I\'d have to ask' },
            { value: 'no_cosigner', label: 'No, just me' },
            { value: 'cash_no_need', label: 'I\'m paying cash — no financing needed' },
          ]}
          value={data.has_cosigner}
          onChange={(v) => update('has_cosigner', v)}
        />
      </div>
    </div>
  )
}

// =============================================
// STEP 7: EDUCATION — FINANCING
// =============================================
function Step7() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className={styles.heading}>Good news — most people get approved</h2>
        <p className={styles.subtext}>We work with multiple lenders to find a plan that fits.</p>
      </div>

      <div className={styles.eduCard}>
        <h3 className={styles.eduTitle}>How we make it affordable</h3>
        <div className={styles.eduPoint}>
          <span className={styles.eduNum}>1</span>
          <span className={styles.eduText}><strong>0% interest plans</strong> for those who qualify — pay over 12 to 24 months with no extra cost</span>
        </div>
        <div className={styles.eduPoint}>
          <span className={styles.eduNum}>2</span>
          <span className={styles.eduText}><strong>Low monthly payments</strong> starting around $199/month for extended plans</span>
        </div>
        <div className={styles.eduPoint}>
          <span className={styles.eduNum}>3</span>
          <span className={styles.eduText}><strong>We try multiple lenders</strong> — if one says no, we try others. Over 85% of patients get approved.</span>
        </div>
        <div className={styles.eduPoint}>
          <span className={styles.eduNum}>4</span>
          <span className={styles.eduText}><strong>No surprise costs</strong> — your quote includes everything: surgery, teeth, follow-ups</span>
        </div>
        <div className={styles.highlight}>
          <p className={styles.highlightText}>
            &quot;I thought I could never afford it. They got me approved at $250 a month. Best money I ever spent.&quot;
          </p>
          <p className="text-sm text-[#8a7d72] mt-2">— Real patient, age 72</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className={styles.stat}>
          <div className={styles.statNum}>85%+</div>
          <div className={styles.statLabel}>Get Approved</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.statNum}>$199</div>
          <div className={styles.statLabel}>Per Month</div>
        </div>
      </div>
    </div>
  )
}

// =============================================
// STEP 8: CONTACT
// =============================================
function Step8({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className={styles.heading}>You&apos;re almost there!</h2>
        <p className={styles.subtext}>
          We just need your name and phone number so we can call you to schedule your <strong>free consultation</strong>.
        </p>
      </div>

      <div className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-base font-semibold text-[#3d3530] mb-2">First Name *</label>
            <input value={data.first_name} onChange={(e) => update('first_name', e.target.value)} placeholder="Your first name" required className={styles.input} />
          </div>
          <div>
            <label className="block text-base font-semibold text-[#3d3530] mb-2">Last Name</label>
            <input value={data.last_name} onChange={(e) => update('last_name', e.target.value)} placeholder="Your last name" className={styles.input} />
          </div>
        </div>
        <div>
          <label className="block text-base font-semibold text-[#3d3530] mb-2">Phone Number *</label>
          <input value={data.phone} onChange={(e) => update('phone', e.target.value)} type="tel" placeholder="(555) 123-4567" required className={styles.input} />
          <p className="text-sm text-[#8a7d72] mt-2">We&apos;ll call or text you to set up your free visit.</p>
        </div>
        <div>
          <label className="block text-base font-semibold text-[#3d3530] mb-2">Email (optional)</label>
          <input value={data.email} onChange={(e) => update('email', e.target.value)} type="email" placeholder="your@email.com" className={styles.input} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-base font-semibold text-[#3d3530] mb-2">City</label>
            <input value={data.city} onChange={(e) => update('city', e.target.value)} placeholder="Your city" className={styles.input} />
          </div>
          <div>
            <label className="block text-base font-semibold text-[#3d3530] mb-2">State</label>
            <input value={data.state} onChange={(e) => update('state', e.target.value)} placeholder="CA" maxLength={2} className={styles.input} />
          </div>
        </div>
      </div>

      <div className="rounded-2xl bg-[#fdf6ee] border-2 border-[#edd9be] p-5 flex items-start gap-4">
        <span className="text-2xl shrink-0">🔒</span>
        <div>
          <p className="text-base font-semibold text-[#3d3530]">We respect your privacy</p>
          <p className="text-sm text-[#8a7d72] mt-1">Your information is private. We will never share it or spam you.</p>
        </div>
      </div>
    </div>
  )
}

// =============================================
// SUCCESS
// =============================================
function StepSuccess({ score, data }: { score: ScoreResult; data: FormData }) {
  const qual = score?.qualification || 'warm'
  const msgs: Record<string, { title: string; desc: string }> = {
    hot: { title: 'Wonderful news!', desc: 'Based on your answers, you look like a great fit for permanent implant teeth. We can\'t wait to help you smile again.' },
    warm: { title: 'Great news!', desc: 'The doctor would love to meet you and talk about your options. A free consultation is the perfect next step.' },
    cold: { title: 'Thank you for sharing!', desc: 'We\'d love to learn more about your situation. A free consultation will help us figure out the best path for you.' },
    unqualified: { title: 'Thank you!', desc: 'We\'ll review your information and reach out to discuss what options might work for you.' },
  }
  const m = msgs[qual] || msgs.warm

  return (
    <div className="text-center space-y-6">
      <div className="inline-flex items-center justify-center w-24 h-24 rounded-full bg-[#f0f7f0] border-2 border-[#c5dfc5]">
        <svg className="w-12 h-12 text-[#4a8c4a]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>

      <div>
        <h2 className="text-3xl font-bold text-[#2d2926]">{m.title}</h2>
        <p className="text-lg text-[#6b5e54] mt-3 max-w-md mx-auto leading-relaxed">{m.desc}</p>
      </div>

      {score && (
        <div className="rounded-2xl bg-[#fdf6ee] border-2 border-[#edd9be] py-6 px-4 inline-block">
          <div className="text-4xl font-bold text-[#c17f3e]">{score.total}<span className="text-xl text-[#d4a668]">/100</span></div>
          <div className="text-sm text-[#8a7d72] mt-1">Your Match Score</div>
        </div>
      )}

      <div className="rounded-2xl bg-white border-2 border-[#e8ddd0] p-6 text-left max-w-sm mx-auto">
        <p className="text-sm font-bold text-[#6b5e54] uppercase tracking-wider mb-4">What happens next</p>
        {[
          `We'll call or text you at ${data.phone}`,
          'Schedule your FREE consultation — no obligation',
          'Meet the doctor, get a scan, see your new smile design',
          'If you love it, we can start right away',
        ].map((t, i) => (
          <div key={i} className="flex items-start gap-3 mb-3 last:mb-0">
            <span className={styles.eduNum}>{i + 1}</span>
            <span className="text-base text-[#5a4f45]">{t}</span>
          </div>
        ))}
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
      <div className="flex justify-between text-sm text-[#8a7d72] mb-2 font-medium">
        <span>Step {current} of {total}</span>
        <span>{Math.round((current / total) * 100)}% done</span>
      </div>
      <div className="h-3 rounded-full bg-[#e8ddd0] overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#c17f3e] to-[#d4a668] transition-all duration-500 ease-out"
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
  orgId, orgName, apiBase = '', utmParams = {},
}: {
  orgId: string; orgName?: string; apiBase?: string; utmParams?: Record<string, string>
}) {
  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [score, setScore] = useState<ScoreResult>(null)

  const [data, setData] = useState<FormData>({
    teeth_situation: '', teeth_count_upper: '', teeth_count_lower: '', has_dentures: '',
    previous_consults: '', previous_consult_locations: '', what_held_back: '',
    urgency: '', pain_level: '',
    credit_score_range: '', monthly_payment_range: '', has_cosigner: '',
    first_name: '', last_name: '', phone: '', email: '', city: '', state: '',
  })

  const update = useCallback((field: keyof FormData, value: string) => {
    setData((prev) => ({ ...prev, [field]: value }))
  }, [])

  const currentConfig = STEP_CONFIG[step - 1]
  const canProceed = currentConfig?.canProceed(data) ?? false

  function mapDentalCondition(): string {
    const m: Record<string, string> = {
      no_teeth: 'missing_all_both', failing_teeth: 'failing_teeth',
      dentures: 'denture_problems', some_missing: 'missing_multiple', not_sure: 'other',
    }
    return m[data.teeth_situation] || 'other'
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
          `Teeth: ${data.teeth_situation}`, `Upper: ${data.teeth_count_upper}`, `Lower: ${data.teeth_count_lower}`,
          `Dentures: ${data.has_dentures}`,
          data.previous_consults !== 'no_first' ? `Prev consults: ${data.previous_consult_locations || data.previous_consults}` : '',
          data.what_held_back ? `Held back by: ${data.what_held_back}` : '',
          `Pain: ${data.pain_level}`, `Credit: ${data.credit_score_range}`,
          `Monthly: ${data.monthly_payment_range}`, `Cosigner: ${data.has_cosigner}`,
        ].filter(Boolean).join(' | '),
        has_dentures: data.has_dentures.includes('denture'),
        urgency: data.urgency,
        financing_interest: data.has_cosigner === 'cash_no_need' ? 'cash_pay' : 'financing_needed',
        has_dental_insurance: false,
        budget_range: data.monthly_payment_range === '500_plus' ? 'over_30k' :
          data.monthly_payment_range === '350_500' ? '20k_25k' :
          data.monthly_payment_range === '200_350' ? '15k_20k' : '10k_15k',
        source_type: utmParams.source_type || 'landing_page',
        utm_source: utmParams.utm_source || undefined, utm_medium: utmParams.utm_medium || undefined,
        utm_campaign: utmParams.utm_campaign || undefined, utm_content: utmParams.utm_content || undefined,
        utm_term: utmParams.utm_term || undefined,
        gclid: utmParams.gclid || undefined, fbclid: utmParams.fbclid || undefined,
        landing_page_url: typeof window !== 'undefined' ? window.location.href : undefined,
      }

      const res = await fetch(`${apiBase}/api/webhooks/qualify?org=${orgId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error('fail')
      const result = await res.json()
      setScore(result.score)
      setSubmitted(true)
      if (typeof window !== 'undefined') {
        if ((window as any).gtag) (window as any).gtag('event', 'conversion', { send_to: 'lead_qualification_complete' })
        if ((window as any).fbq) (window as any).fbq('track', 'Lead')
      }
    } catch { alert('Something went wrong. Please try again or call us.') }
    finally { setSubmitting(false) }
  }

  function next() { step === TOTAL_STEPS ? handleSubmit() : setStep((s) => s + 1) }
  function back() { setStep((s) => Math.max(1, s - 1)) }

  if (submitted) {
    return (
      <div className="max-w-xl mx-auto px-5 py-10">
        <StepSuccess score={score} data={data} />
      </div>
    )
  }

  return (
    <div className="max-w-xl mx-auto px-5 py-6">
      <ProgressBar current={step} total={TOTAL_STEPS} />

      <div className="min-h-[420px]">
        {step === 1 && <Step1 data={data} update={update} />}
        {step === 2 && <Step2 />}
        {step === 3 && <Step3 data={data} update={update} />}
        {step === 4 && <Step4 />}
        {step === 5 && <Step5 data={data} update={update} />}
        {step === 6 && <Step6 data={data} update={update} />}
        {step === 7 && <Step7 />}
        {step === 8 && <Step8 data={data} update={update} />}
      </div>

      <div className="flex items-center justify-between mt-10">
        {step > 1 ? (
          <button type="button" onClick={back} className={styles.btnBack}>
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            Back
          </button>
        ) : <div />}

        <button type="button" onClick={next} disabled={!canProceed || submitting} className={styles.btnPrimary(canProceed && !submitting)}>
          {submitting ? (
            <><svg className="animate-spin h-5 w-5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg> One moment...</>
          ) : step === TOTAL_STEPS ? (
            'See My Results →'
          ) : currentConfig?.type === 'education' ? (
            'I understand — continue →'
          ) : (
            'Next Step →'
          )}
        </button>
      </div>
    </div>
  )
}
