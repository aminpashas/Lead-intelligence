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
  type: 'question' | 'hype'
  canProceed: (data: FormData) => boolean
}

const STEP_CONFIG: StepConfig[] = [
  { type: 'question', canProceed: (d) => !!d.teeth_situation },
  { type: 'hype', canProceed: () => true },
  { type: 'question', canProceed: (d) => !!d.previous_consults },
  { type: 'hype', canProceed: () => true },
  { type: 'question', canProceed: (d) => !!d.urgency && !!d.pain_level },
  { type: 'question', canProceed: (d) => !!d.credit_score_range && !!d.monthly_payment_range },
  { type: 'hype', canProceed: () => true },
  { type: 'question', canProceed: (d) => !!d.first_name && !!d.phone && d.phone.replace(/\D/g, '').length >= 7 },
]
const TOTAL_STEPS = STEP_CONFIG.length

// =============================================
// BIG SIMPLE OPTION BUTTON
// =============================================
function BigOption({ selected, onClick, children, badge }: {
  selected: boolean; onClick: () => void; children: React.ReactNode; badge?: string
}) {
  return (
    <button type="button" onClick={onClick} className="w-full text-left" style={{
      display: 'flex', alignItems: 'center', gap: '16px',
      padding: '18px 20px', borderRadius: '16px', border: `3px solid ${selected ? '#d97706' : '#e5e0d8'}`,
      background: selected ? '#fffbeb' : '#fff', cursor: 'pointer', transition: 'all 0.15s',
      boxShadow: selected ? '0 0 0 1px #d97706' : 'none', position: 'relative',
    }}>
      <span style={{
        width: '28px', height: '28px', borderRadius: '50%', border: `3px solid ${selected ? '#d97706' : '#ccc'}`,
        background: selected ? '#d97706' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {selected && <svg width="14" height="14" viewBox="0 0 12 12" fill="white"><path d="M10.28 2.28L3.989 8.575 1.695 6.28A1 1 0 00.28 7.695l3 3a1 1 0 001.414 0l7-7A1 1 0 0010.28 2.28z"/></svg>}
      </span>
      <span style={{ fontSize: '17px', fontWeight: 600, color: '#1f1a15', lineHeight: 1.4, flex: 1 }}>{children}</span>
      {badge && (
        <span style={{
          background: '#dc2626', color: '#fff', fontSize: '11px', fontWeight: 800,
          padding: '3px 8px', borderRadius: '6px', textTransform: 'uppercase', letterSpacing: '0.5px',
        }}>{badge}</span>
      )}
    </button>
  )
}

// =============================================
// HYPE BLOCK — attention-grabbing, deal-focused
// =============================================
function HypeBlock({ icon, headline, body, stat, statLabel, testimonial, testimonialAge, callout }: {
  icon?: string; headline: string; body: string
  stat?: string; statLabel?: string
  testimonial?: string; testimonialAge?: string
  callout?: string
}) {
  return (
    <div>
      <div style={{
        background: 'linear-gradient(135deg, #fef3c7 0%, #fffbeb 50%, #fef9ee 100%)',
        border: '3px solid #f59e0b', borderRadius: '20px', padding: '28px 24px',
      }}>
        {icon && <div style={{ fontSize: '48px', marginBottom: '12px' }}>{icon}</div>}
        <h3 style={{ fontSize: '22px', fontWeight: 800, color: '#92400e', lineHeight: 1.3, marginBottom: '12px' }}>
          {headline}
        </h3>
        <p style={{ fontSize: '17px', color: '#78350f', lineHeight: 1.7 }}>{body}</p>

        {testimonial && (
          <div style={{
            marginTop: '20px', background: '#fff', border: '2px solid #fbbf24',
            borderRadius: '16px', padding: '16px 20px',
          }}>
            <p style={{ fontSize: '16px', fontStyle: 'italic', color: '#92400e', lineHeight: 1.6 }}>
              &ldquo;{testimonial}&rdquo;
            </p>
            {testimonialAge && <p style={{ fontSize: '14px', color: '#b45309', marginTop: '8px', fontWeight: 600 }}>— {testimonialAge}</p>}
          </div>
        )}
      </div>

      {(stat || callout) && (
        <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
          {stat && (
            <div style={{
              flex: 1, background: '#fff', border: '2px solid #e5e0d8', borderRadius: '16px',
              padding: '16px', textAlign: 'center',
            }}>
              <div style={{ fontSize: '32px', fontWeight: 800, color: '#d97706' }}>{stat}</div>
              <div style={{ fontSize: '13px', color: '#78716c', marginTop: '4px' }}>{statLabel}</div>
            </div>
          )}
          {callout && (
            <div style={{
              flex: 2, background: '#dc2626', borderRadius: '16px', padding: '16px 20px',
              display: 'flex', alignItems: 'center',
            }}>
              <p style={{ fontSize: '16px', fontWeight: 700, color: '#fff', lineHeight: 1.4 }}>{callout}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================
// STEP 1
// =============================================
function Step1({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <div style={{ background: '#dc2626', color: '#fff', textAlign: 'center', padding: '10px', borderRadius: '12px', marginBottom: '24px', fontSize: '14px', fontWeight: 700, letterSpacing: '0.5px' }}>
        LIMITED SPOTS — FREE CONSULTATIONS FILLING UP FAST
      </div>
      <h2 style={{ fontSize: '26px', fontWeight: 800, color: '#1f1a15', lineHeight: 1.3, marginBottom: '8px' }}>
        Quick question — what&apos;s going on with your teeth?
      </h2>
      <p style={{ fontSize: '16px', color: '#78716c', marginBottom: '24px' }}>
        Just tap the one that sounds like you. Takes 2 minutes.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <BigOption selected={data.teeth_situation === 'no_teeth'} onClick={() => update('teeth_situation', 'no_teeth')}>
          I&apos;ve lost all (or almost all) my teeth
        </BigOption>
        <BigOption selected={data.teeth_situation === 'dentures'} onClick={() => update('teeth_situation', 'dentures')} badge="MOST COMMON">
          I wear dentures and I&apos;m sick of them
        </BigOption>
        <BigOption selected={data.teeth_situation === 'failing_teeth'} onClick={() => update('teeth_situation', 'failing_teeth')}>
          My teeth are falling apart — they need to go
        </BigOption>
        <BigOption selected={data.teeth_situation === 'some_missing'} onClick={() => update('teeth_situation', 'some_missing')}>
          I&apos;m missing a bunch of teeth
        </BigOption>
        <BigOption selected={data.teeth_situation === 'not_sure'} onClick={() => update('teeth_situation', 'not_sure')}>
          I just want to be able to smile again
        </BigOption>
      </div>

      {data.teeth_situation && (
        <div style={{ marginTop: '32px' }}>
          <p style={{ fontSize: '16px', fontWeight: 700, color: '#1f1a15', marginBottom: '16px' }}>
            How many real teeth you got left on top?
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {[
              { v: 'none', l: 'Zero — none left' },
              { v: '1_5', l: 'A few (1-5)' },
              { v: '6_plus', l: '6 or more' },
              { v: 'not_sure_upper', l: 'Not sure' },
            ].map((o) => (
              <BigOption key={o.v} selected={data.teeth_count_upper === o.v} onClick={() => update('teeth_count_upper', o.v)}>{o.l}</BigOption>
            ))}
          </div>

          <p style={{ fontSize: '16px', fontWeight: 700, color: '#1f1a15', marginBottom: '16px', marginTop: '24px' }}>
            And on the bottom?
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {[
              { v: 'none', l: 'Zero — none left' },
              { v: '1_5', l: 'A few (1-5)' },
              { v: '6_plus', l: '6 or more' },
              { v: 'not_sure_lower', l: 'Not sure' },
            ].map((o) => (
              <BigOption key={o.v} selected={data.teeth_count_lower === o.v} onClick={() => update('teeth_count_lower', o.v)}>{o.l}</BigOption>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// =============================================
// STEP 2: HYPE — THE HOOK
// =============================================
function Step2() {
  return (
    <HypeBlock
      icon="🔥"
      headline="People are throwing away their dentures and getting PERMANENT teeth — in ONE day"
      body="No glue. No slipping. No gagging. You walk in with bad teeth (or no teeth) and walk out the SAME DAY biting into a burger. This isn't some futuristic thing — thousands of regular people are doing it right now."
      testimonial="I threw my dentures in the trash on the way out. Best day of my life. I can eat ribs again!"
      testimonialAge="Patricia, 68 — Retired Walmart cashier"
      stat="1 DAY"
      statLabel="New teeth, same day"
      callout="This used to only be for rich people. NOT ANYMORE. Keep going to see if you qualify →"
    />
  )
}

// =============================================
// STEP 3: PREVIOUS CONSULTS
// =============================================
function Step3({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <h2 style={{ fontSize: '26px', fontWeight: 800, color: '#1f1a15', lineHeight: 1.3, marginBottom: '8px' }}>
        Have you looked into implants before?
      </h2>
      <p style={{ fontSize: '16px', color: '#78716c', marginBottom: '24px' }}>
        Be honest — lots of people have. That&apos;s totally normal.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <BigOption selected={data.previous_consults === 'yes_multiple'} onClick={() => update('previous_consults', 'yes_multiple')}>
          Yeah, I&apos;ve been to a couple places already
        </BigOption>
        <BigOption selected={data.previous_consults === 'yes_one'} onClick={() => update('previous_consults', 'yes_one')}>
          I went to one consultation but didn&apos;t do it
        </BigOption>
        <BigOption selected={data.previous_consults === 'no_first'} onClick={() => update('previous_consults', 'no_first')} badge="NO WORRIES">
          Nope, first time looking into this
        </BigOption>
      </div>

      {(data.previous_consults === 'yes_multiple' || data.previous_consults === 'yes_one') && (
        <div style={{ marginTop: '28px' }}>
          <p style={{ fontSize: '16px', fontWeight: 700, color: '#1f1a15', marginBottom: '12px' }}>
            Where did you go? (ClearChoice, Aspen, a local place?)
          </p>
          <input
            value={data.previous_consult_locations}
            onChange={(e) => update('previous_consult_locations', e.target.value)}
            placeholder="Type the name..."
            style={{
              width: '100%', padding: '16px 20px', fontSize: '17px', border: '3px solid #e5e0d8',
              borderRadius: '16px', outline: 'none', background: '#fff', color: '#1f1a15',
              boxSizing: 'border-box',
            }}
          />

          <p style={{ fontSize: '16px', fontWeight: 700, color: '#1f1a15', marginBottom: '16px', marginTop: '24px' }}>
            What stopped you?
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <BigOption selected={data.what_held_back === 'too_expensive'} onClick={() => update('what_held_back', 'too_expensive')} badge="WE CAN BEAT IT">
              Way too expensive
            </BigOption>
            <BigOption selected={data.what_held_back === 'financing_denied'} onClick={() => update('what_held_back', 'financing_denied')}>
              Couldn&apos;t get approved for financing
            </BigOption>
            <BigOption selected={data.what_held_back === 'not_confident'} onClick={() => update('what_held_back', 'not_confident')}>
              Didn&apos;t trust the doctor
            </BigOption>
            <BigOption selected={data.what_held_back === 'fear'} onClick={() => update('what_held_back', 'fear')}>
              Too scared of the procedure
            </BigOption>
            <BigOption selected={data.what_held_back === 'need_time'} onClick={() => update('what_held_back', 'need_time')}>
              Just needed more time
            </BigOption>
          </div>
        </div>
      )}
    </div>
  )
}

// =============================================
// STEP 4: HYPE — DEAL + TRUST
// =============================================
function Step4() {
  return (
    <HypeBlock
      icon="💰"
      headline="We're NOT ClearChoice. We don't charge $40,000."
      body="Those big chains spend millions on TV ads — and YOU pay for it. We keep costs low and pass the savings to you. Same procedure. Same quality materials. Board-certified surgeon. Just without the ridiculous markup."
      testimonial="ClearChoice quoted me $36,000. I got the same thing here for way less. Same implants, same brand. I couldn't believe it."
      testimonialAge="Robert, 71 — Retired truck driver"
      stat="50%"
      statLabel="Less than chains"
      callout="You're already halfway through — let's see if you qualify for our special pricing →"
    />
  )
}

// =============================================
// STEP 5: URGENCY + PAIN
// =============================================
function Step5({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <h2 style={{ fontSize: '26px', fontWeight: 800, color: '#1f1a15', lineHeight: 1.3, marginBottom: '8px' }}>
        Real talk — how bad is it right now?
      </h2>
      <p style={{ fontSize: '16px', color: '#78716c', marginBottom: '24px' }}>
        No judgment. We&apos;ve heard it all and we&apos;re here to help.
      </p>

      <p style={{ fontSize: '16px', fontWeight: 700, color: '#1f1a15', marginBottom: '16px' }}>
        What&apos;s bothering you the most?
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '28px' }}>
        <BigOption selected={data.pain_level === 'severe_pain'} onClick={() => update('pain_level', 'severe_pain')} badge="URGENT">
          I&apos;m in pain — it&apos;s affecting my daily life
        </BigOption>
        <BigOption selected={data.pain_level === 'cant_eat'} onClick={() => update('pain_level', 'cant_eat')}>
          I can&apos;t eat the foods I want
        </BigOption>
        <BigOption selected={data.pain_level === 'embarrassment'} onClick={() => update('pain_level', 'embarrassment')}>
          I&apos;m embarrassed — I don&apos;t smile anymore
        </BigOption>
        <BigOption selected={data.pain_level === 'dentures_suck'} onClick={() => update('pain_level', 'dentures_suck')}>
          My dentures are driving me crazy
        </BigOption>
        <BigOption selected={data.pain_level === 'all_above'} onClick={() => update('pain_level', 'all_above')}>
          All of the above honestly
        </BigOption>
      </div>

      <p style={{ fontSize: '16px', fontWeight: 700, color: '#1f1a15', marginBottom: '16px' }}>
        If everything lined up — would you be ready to do this?
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <BigOption selected={data.urgency === 'asap'} onClick={() => update('urgency', 'asap')} badge="BEST DEALS">
          Yes — I&apos;ve waited long enough
        </BigOption>
        <BigOption selected={data.urgency === '1_3_months'} onClick={() => update('urgency', '1_3_months')}>
          Within the next couple months
        </BigOption>
        <BigOption selected={data.urgency === 'depends'} onClick={() => update('urgency', 'depends')}>
          Depends on the price honestly
        </BigOption>
        <BigOption selected={data.urgency === 'not_sure'} onClick={() => update('urgency', 'not_sure')}>
          I want to but I keep putting it off
        </BigOption>
      </div>
    </div>
  )
}

// =============================================
// STEP 6: FINANCING
// =============================================
function Step6({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <h2 style={{ fontSize: '26px', fontWeight: 800, color: '#1f1a15', lineHeight: 1.3, marginBottom: '8px' }}>
        Let&apos;s figure out the money part
      </h2>
      <p style={{ fontSize: '16px', color: '#78716c', marginBottom: '24px' }}>
        Almost everyone uses a payment plan. No shame in that. We make it work.
      </p>

      <p style={{ fontSize: '16px', fontWeight: 700, color: '#1f1a15', marginBottom: '16px' }}>
        Any idea what your credit score is?
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '28px' }}>
        <BigOption selected={data.credit_score_range === '720_plus'} onClick={() => update('credit_score_range', '720_plus')} badge="BEST RATES">
          Pretty good — 720 or higher
        </BigOption>
        <BigOption selected={data.credit_score_range === '680_719'} onClick={() => update('credit_score_range', '680_719')}>
          Decent — somewhere around 680-719
        </BigOption>
        <BigOption selected={data.credit_score_range === '600_679'} onClick={() => update('credit_score_range', '600_679')}>
          It&apos;s okay — 600 to 679ish
        </BigOption>
        <BigOption selected={data.credit_score_range === 'below_600'} onClick={() => update('credit_score_range', 'below_600')}>
          It&apos;s not great — under 600
        </BigOption>
        <BigOption selected={data.credit_score_range === 'not_sure_credit'} onClick={() => update('credit_score_range', 'not_sure_credit')}>
          No clue honestly
        </BigOption>
      </div>

      <p style={{ fontSize: '16px', fontWeight: 700, color: '#1f1a15', marginBottom: '16px' }}>
        What monthly payment could you swing?
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '28px' }}>
        <BigOption selected={data.monthly_payment_range === 'under_200'} onClick={() => update('monthly_payment_range', 'under_200')}>
          Under $200/month
        </BigOption>
        <BigOption selected={data.monthly_payment_range === '200_350'} onClick={() => update('monthly_payment_range', '200_350')} badge="MOST POPULAR">
          $200 to $350/month
        </BigOption>
        <BigOption selected={data.monthly_payment_range === '350_500'} onClick={() => update('monthly_payment_range', '350_500')}>
          $350 to $500/month
        </BigOption>
        <BigOption selected={data.monthly_payment_range === '500_plus'} onClick={() => update('monthly_payment_range', '500_plus')}>
          $500+ or paying cash
        </BigOption>
        <BigOption selected={data.monthly_payment_range === 'need_to_discuss'} onClick={() => update('monthly_payment_range', 'need_to_discuss')}>
          I need to talk about it first
        </BigOption>
      </div>

      <p style={{ fontSize: '16px', fontWeight: 700, color: '#1f1a15', marginBottom: '12px' }}>
        Got a spouse or family member who could co-sign?
      </p>
      <p style={{ fontSize: '14px', color: '#78716c', marginBottom: '16px' }}>
        This can really help get you approved with a better rate.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <BigOption selected={data.has_cosigner === 'yes_cosigner'} onClick={() => update('has_cosigner', 'yes_cosigner')}>
          Yes — my spouse/family can help
        </BigOption>
        <BigOption selected={data.has_cosigner === 'maybe_cosigner'} onClick={() => update('has_cosigner', 'maybe_cosigner')}>
          Maybe — I&apos;d have to check
        </BigOption>
        <BigOption selected={data.has_cosigner === 'no_cosigner'} onClick={() => update('has_cosigner', 'no_cosigner')}>
          No, just me
        </BigOption>
        <BigOption selected={data.has_cosigner === 'cash_no_need'} onClick={() => update('has_cosigner', 'cash_no_need')}>
          Paying cash — don&apos;t need it
        </BigOption>
      </div>
    </div>
  )
}

// =============================================
// STEP 7: HYPE — FINAL PUSH
// =============================================
function Step7() {
  return (
    <HypeBlock
      icon="🎉"
      headline="You're almost done — and here's the BEST part"
      body="Your consultation is 100% FREE. Free CT scan. Free smile design. Free treatment plan. You'll see exactly what your new teeth will look like BEFORE you spend a dime. No pressure. No commitment. If you don't love it, you walk away. Simple."
      testimonial="I was so nervous walking in. They showed me what my smile would look like on a screen and I started crying. I signed up that day. Zero regrets."
      testimonialAge="Linda, 65 — Grandmother of 4"
      stat="FREE"
      statLabel="Consultation + CT Scan"
      callout="Just one more step — give us your name and number so we can get you scheduled! →"
    />
  )
}

// =============================================
// STEP 8: CONTACT
// =============================================
function Step8({ data, update }: { data: FormData; update: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <h2 style={{ fontSize: '26px', fontWeight: 800, color: '#1f1a15', lineHeight: 1.3, marginBottom: '8px' }}>
        Last step — where should we call you?
      </h2>
      <p style={{ fontSize: '16px', color: '#78716c', marginBottom: '28px' }}>
        We&apos;ll call to schedule your <strong>FREE consultation</strong>. No spam, no BS — just a real person helping you get your smile back.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '15px', fontWeight: 700, color: '#1f1a15', marginBottom: '8px' }}>First Name *</label>
            <input value={data.first_name} onChange={(e) => update('first_name', e.target.value)} placeholder="Your first name" required
              style={{ width: '100%', padding: '16px 18px', fontSize: '17px', border: '3px solid #e5e0d8', borderRadius: '14px', outline: 'none', background: '#fff', color: '#1f1a15', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '15px', fontWeight: 700, color: '#1f1a15', marginBottom: '8px' }}>Last Name</label>
            <input value={data.last_name} onChange={(e) => update('last_name', e.target.value)} placeholder="Last name"
              style={{ width: '100%', padding: '16px 18px', fontSize: '17px', border: '3px solid #e5e0d8', borderRadius: '14px', outline: 'none', background: '#fff', color: '#1f1a15', boxSizing: 'border-box' }}
            />
          </div>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '15px', fontWeight: 700, color: '#1f1a15', marginBottom: '8px' }}>Phone Number *</label>
          <input value={data.phone} onChange={(e) => update('phone', e.target.value)} type="tel" placeholder="(555) 123-4567" required
            style={{ width: '100%', padding: '16px 18px', fontSize: '20px', fontWeight: 600, border: '3px solid #d97706', borderRadius: '14px', outline: 'none', background: '#fffbeb', color: '#1f1a15', boxSizing: 'border-box' }}
          />
          <p style={{ fontSize: '13px', color: '#78716c', marginTop: '8px' }}>We&apos;ll call or text to set up your FREE visit</p>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '15px', fontWeight: 700, color: '#1f1a15', marginBottom: '8px' }}>Email (optional)</label>
          <input value={data.email} onChange={(e) => update('email', e.target.value)} type="email" placeholder="your@email.com"
            style={{ width: '100%', padding: '16px 18px', fontSize: '17px', border: '3px solid #e5e0d8', borderRadius: '14px', outline: 'none', background: '#fff', color: '#1f1a15', boxSizing: 'border-box' }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '15px', fontWeight: 700, color: '#1f1a15', marginBottom: '8px' }}>City</label>
            <input value={data.city} onChange={(e) => update('city', e.target.value)} placeholder="Your city"
              style={{ width: '100%', padding: '16px 18px', fontSize: '17px', border: '3px solid #e5e0d8', borderRadius: '14px', outline: 'none', background: '#fff', color: '#1f1a15', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '15px', fontWeight: 700, color: '#1f1a15', marginBottom: '8px' }}>State</label>
            <input value={data.state} onChange={(e) => update('state', e.target.value)} placeholder="CA" maxLength={2}
              style={{ width: '100%', padding: '16px 18px', fontSize: '17px', border: '3px solid #e5e0d8', borderRadius: '14px', outline: 'none', background: '#fff', color: '#1f1a15', boxSizing: 'border-box' }}
            />
          </div>
        </div>
      </div>

      <div style={{ marginTop: '20px', background: '#f0fdf4', border: '2px solid #bbf7d0', borderRadius: '14px', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '24px' }}>🔒</span>
        <p style={{ fontSize: '14px', color: '#166534' }}>
          <strong>100% private.</strong> We will NEVER sell your info or spam you. That&apos;s a promise.
        </p>
      </div>
    </div>
  )
}

// =============================================
// SUCCESS
// =============================================
function StepSuccess({ score, data }: { score: ScoreResult; data: FormData }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        width: '80px', height: '80px', borderRadius: '50%', background: '#f0fdf4', border: '3px solid #bbf7d0',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px',
      }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 13l4 4L19 7"/>
        </svg>
      </div>

      <h2 style={{ fontSize: '28px', fontWeight: 800, color: '#1f1a15', marginBottom: '12px' }}>
        You did it, {data.first_name}! 🎉
      </h2>

      <div style={{
        background: 'linear-gradient(135deg, #fef3c7, #fffbeb)', border: '3px solid #f59e0b',
        borderRadius: '20px', padding: '24px', marginBottom: '24px',
      }}>
        <p style={{ fontSize: '18px', fontWeight: 700, color: '#92400e', marginBottom: '12px' }}>
          {score && score.qualification === 'hot' ? "GREAT NEWS — you look like an EXCELLENT candidate!" :
           score && score.qualification === 'warm' ? "Looking good! You could be a great candidate." :
           "Thanks for completing the assessment!"}
        </p>
        {score && (
          <div style={{ fontSize: '48px', fontWeight: 800, color: '#d97706' }}>
            {score.total}<span style={{ fontSize: '24px', color: '#b45309' }}>/100</span>
          </div>
        )}
        <p style={{ fontSize: '14px', color: '#92400e', marginTop: '8px' }}>Match Score</p>
      </div>

      <p style={{ fontSize: '17px', color: '#57534e', lineHeight: 1.6, marginBottom: '24px' }}>
        A real person from our team will <strong>call or text you at {data.phone}</strong> within 24 hours to schedule your <strong>FREE consultation</strong>.
      </p>

      <div style={{
        background: '#fff', border: '3px solid #e5e0d8', borderRadius: '20px', padding: '24px', textAlign: 'left',
      }}>
        <p style={{ fontSize: '13px', fontWeight: 700, color: '#78716c', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '16px' }}>
          Here&apos;s what happens next
        </p>
        {[
          'We call you to pick a time that works',
          'You come in for a FREE consult + CT scan',
          'The doctor shows you what your new smile will look like',
          'If you love it, you could have new teeth THAT WEEK',
        ].map((t, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '12px' }}>
            <span style={{
              width: '28px', height: '28px', borderRadius: '50%', background: '#d97706', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700, flexShrink: 0,
            }}>{i + 1}</span>
            <span style={{ fontSize: '16px', color: '#44403c' }}>{t}</span>
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
  const pct = Math.round((current / total) * 100)
  return (
    <div style={{ marginBottom: '28px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', fontWeight: 600, color: '#78716c', marginBottom: '8px' }}>
        <span>Step {current} of {total}</span>
        <span>{pct}% done</span>
      </div>
      <div style={{ height: '12px', borderRadius: '999px', background: '#e5e0d8', overflow: 'hidden' }}>
        <div style={{
          height: '100%', borderRadius: '999px', transition: 'width 0.5s ease',
          background: 'linear-gradient(90deg, #d97706, #f59e0b)', width: `${pct}%`,
        }} />
      </div>
    </div>
  )
}

// =============================================
// MAIN
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
    const m: Record<string, string> = { no_teeth: 'missing_all_both', failing_teeth: 'failing_teeth', dentures: 'denture_problems', some_missing: 'missing_multiple', not_sure: 'other' }
    return m[data.teeth_situation] || 'other'
  }

  async function handleSubmit() {
    setSubmitting(true)
    try {
      const payload = {
        first_name: data.first_name, last_name: data.last_name || undefined,
        phone: data.phone, email: data.email || undefined,
        city: data.city || undefined, state: data.state || undefined,
        dental_condition: mapDentalCondition(),
        dental_condition_details: [
          `Teeth: ${data.teeth_situation}`, `Upper: ${data.teeth_count_upper}`, `Lower: ${data.teeth_count_lower}`,
          `Dentures: ${data.has_dentures}`,
          data.previous_consults !== 'no_first' ? `Prev: ${data.previous_consult_locations || data.previous_consults}` : '',
          data.what_held_back ? `Held back: ${data.what_held_back}` : '',
          `Pain: ${data.pain_level}`, `Credit: ${data.credit_score_range}`,
          `Monthly: ${data.monthly_payment_range}`, `Cosigner: ${data.has_cosigner}`,
        ].filter(Boolean).join(' | '),
        has_dentures: (data.has_dentures || '').includes('denture'),
        urgency: data.urgency,
        financing_interest: data.has_cosigner === 'cash_no_need' ? 'cash_pay' : 'financing_needed',
        has_dental_insurance: false,
        budget_range: data.monthly_payment_range === '500_plus' ? 'over_30k' : data.monthly_payment_range === '350_500' ? '20k_25k' : data.monthly_payment_range === '200_350' ? '15k_20k' : '10k_15k',
        source_type: utmParams.source_type || 'landing_page',
        utm_source: utmParams.utm_source || undefined, utm_medium: utmParams.utm_medium || undefined,
        utm_campaign: utmParams.utm_campaign || undefined, gclid: utmParams.gclid || undefined, fbclid: utmParams.fbclid || undefined,
        landing_page_url: typeof window !== 'undefined' ? window.location.href : undefined,
      }
      const res = await fetch(`${apiBase}/api/webhooks/qualify?org=${orgId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!res.ok) throw new Error('fail')
      const result = await res.json()
      setScore(result.score); setSubmitted(true)
      if (typeof window !== 'undefined') {
        if ((window as any).gtag) (window as any).gtag('event', 'conversion', { send_to: 'lead_qualification_complete' })
        if ((window as any).fbq) (window as any).fbq('track', 'Lead')
      }
    } catch { alert('Something went wrong. Please call us directly.') }
    finally { setSubmitting(false) }
  }

  function next() { step === TOTAL_STEPS ? handleSubmit() : setStep((s) => s + 1) }
  function back() { setStep((s) => Math.max(1, s - 1)) }

  if (submitted) return <div style={{ maxWidth: '540px', margin: '0 auto', padding: '24px 20px' }}><StepSuccess score={score} data={data} /></div>

  return (
    <div style={{ maxWidth: '540px', margin: '0 auto', padding: '16px 20px' }}>
      <ProgressBar current={step} total={TOTAL_STEPS} />
      <div style={{ minHeight: '420px' }}>
        {step === 1 && <Step1 data={data} update={update} />}
        {step === 2 && <Step2 />}
        {step === 3 && <Step3 data={data} update={update} />}
        {step === 4 && <Step4 />}
        {step === 5 && <Step5 data={data} update={update} />}
        {step === 6 && <Step6 data={data} update={update} />}
        {step === 7 && <Step7 />}
        {step === 8 && <Step8 data={data} update={update} />}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '32px' }}>
        {step > 1 ? (
          <button type="button" onClick={back} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '16px', color: '#78716c', background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}>
            ← Back
          </button>
        ) : <div />}

        <button type="button" onClick={next} disabled={!canProceed || submitting} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          padding: '18px 36px', fontSize: '18px', fontWeight: 800, borderRadius: '16px', border: 'none', cursor: canProceed && !submitting ? 'pointer' : 'not-allowed',
          background: canProceed && !submitting ? 'linear-gradient(135deg, #d97706, #b45309)' : '#e5e0d8',
          color: canProceed && !submitting ? '#fff' : '#a8a29e',
          boxShadow: canProceed && !submitting ? '0 4px 14px rgba(217,119,6,0.3)' : 'none',
          transition: 'all 0.15s', width: '100%', maxWidth: step > 1 ? '280px' : '100%',
        }}>
          {submitting ? 'Checking...' : step === TOTAL_STEPS ? 'SEE MY RESULTS →' : currentConfig?.type === 'hype' ? 'KEEP GOING →' : 'NEXT STEP →'}
        </button>
      </div>
    </div>
  )
}
