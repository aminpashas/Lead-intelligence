'use client'

import { useState, useCallback } from 'react'

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

type StepConfig = { type: 'question' | 'hype'; canProceed: (d: FormData) => boolean }

const STEPS: StepConfig[] = [
  { type: 'question', canProceed: (d) => !!d.teeth_situation },
  { type: 'hype', canProceed: () => true },
  { type: 'question', canProceed: (d) => !!d.previous_consults },
  { type: 'hype', canProceed: () => true },
  { type: 'question', canProceed: (d) => !!d.urgency && !!d.pain_level },
  { type: 'question', canProceed: (d) => !!d.credit_score_range && !!d.monthly_payment_range },
  { type: 'hype', canProceed: () => true },
  { type: 'question', canProceed: (d) => !!d.first_name && !!d.phone && d.phone.replace(/\D/g, '').length >= 7 },
]

// ── Shared Components ──────────────────────────────

function Pill({ selected, onClick, children, badge }: { selected: boolean; onClick: () => void; children: React.ReactNode; badge?: string }) {
  return (
    <button type="button" onClick={onClick} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: '14px', padding: '16px 18px',
      borderRadius: '14px', border: `3px solid ${selected ? '#d97706' : '#e5e0d8'}`,
      background: selected ? '#fffbeb' : '#fff', cursor: 'pointer', transition: 'all .15s',
      boxShadow: selected ? '0 0 0 1px #d97706' : 'none', textAlign: 'left', position: 'relative',
    }}>
      <span style={{ width: '24px', height: '24px', borderRadius: '50%', border: `3px solid ${selected ? '#d97706' : '#ccc'}`,
        background: selected ? '#d97706' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {selected && <svg width="12" height="12" viewBox="0 0 12 12" fill="#fff"><path d="M10.28 2.28L3.989 8.575 1.695 6.28A1 1 0 00.28 7.695l3 3a1 1 0 001.414 0l7-7A1 1 0 0010.28 2.28z"/></svg>}
      </span>
      <span style={{ fontSize: '16px', fontWeight: 600, color: '#1f1a15', lineHeight: 1.4, flex: 1 }}>{children}</span>
      {badge && <span style={{ background: badge === 'MOST COMMON' ? '#d97706' : '#dc2626', color: '#fff', fontSize: '10px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px', textTransform: 'uppercase', letterSpacing: '.5px', whiteSpace: 'nowrap' }}>{badge}</span>}
    </button>
  )
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: '24px', fontWeight: 800, color: '#1f1a15', lineHeight: 1.3, marginBottom: '6px' }}>{children}</h2>
}
function Sub({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: '15px', color: '#78716c', marginBottom: '22px', lineHeight: 1.5 }}>{children}</p>
}
function Label({ children }: { children: React.ReactNode }) {
  return <p style={{ fontSize: '15px', fontWeight: 700, color: '#1f1a15', marginBottom: '14px', marginTop: '24px' }}>{children}</p>
}
function Input({ value, onChange, placeholder, type, highlight, note }: { value: string; onChange: (v: string) => void; placeholder: string; type?: string; highlight?: boolean; note?: string }) {
  return (
    <div>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type={type || 'text'}
        style={{ width: '100%', padding: '15px 18px', fontSize: '17px', border: `3px solid ${highlight ? '#d97706' : '#e5e0d8'}`, borderRadius: '14px', outline: 'none', background: highlight ? '#fffbeb' : '#fff', color: '#1f1a15', boxSizing: 'border-box' as const }} />
      {note && <p style={{ fontSize: '13px', color: '#78716c', marginTop: '6px' }}>{note}</p>}
    </div>
  )
}
function Stack({ children, gap }: { children: React.ReactNode; gap?: number }) {
  return <div style={{ display: 'flex', flexDirection: 'column' as const, gap: `${gap || 10}px` }}>{children}</div>
}

// ── Step 1: Teeth Situation ────────────────────────

function S1({ data, u }: { data: FormData; u: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <div style={{ background: '#dc2626', color: '#fff', textAlign: 'center', padding: '10px', borderRadius: '12px', marginBottom: '20px', fontSize: '13px', fontWeight: 700, letterSpacing: '.5px' }}>
        ⚡ ONLY 7 FREE CONSULTATION SPOTS LEFT THIS MONTH
      </div>
      <Heading>Quick question — what&apos;s going on with your teeth?</Heading>
      <Sub>Tap the one that sounds like you. Takes 2 min.</Sub>
      <Stack>
        <Pill selected={data.teeth_situation === 'no_teeth'} onClick={() => u('teeth_situation', 'no_teeth')}>I&apos;ve lost all or almost all my teeth</Pill>
        <Pill selected={data.teeth_situation === 'dentures'} onClick={() => u('teeth_situation', 'dentures')} badge="MOST COMMON">I wear dentures and I&apos;m DONE with them</Pill>
        <Pill selected={data.teeth_situation === 'failing'} onClick={() => u('teeth_situation', 'failing')}>My teeth are falling apart — they need to go</Pill>
        <Pill selected={data.teeth_situation === 'some_missing'} onClick={() => u('teeth_situation', 'some_missing')}>I&apos;m missing a bunch of teeth</Pill>
        <Pill selected={data.teeth_situation === 'not_sure'} onClick={() => u('teeth_situation', 'not_sure')}>I just want to smile and eat normal again</Pill>
      </Stack>
      {data.teeth_situation && <>
        <Label>How many real teeth left on top?</Label>
        <Stack>{[['none','Zero — all gone'],['1_5','A few (1-5)'],['6_plus','6 or more'],['idk_upper','Not sure']].map(([v,l]) =>
          <Pill key={v} selected={data.teeth_count_upper===v} onClick={() => u('teeth_count_upper',v)}>{l}</Pill>
        )}</Stack>
        <Label>And on the bottom?</Label>
        <Stack>{[['none','Zero — all gone'],['1_5','A few (1-5)'],['6_plus','6 or more'],['idk_lower','Not sure']].map(([v,l]) =>
          <Pill key={v} selected={data.teeth_count_lower===v} onClick={() => u('teeth_count_lower',v)}>{l}</Pill>
        )}</Stack>
      </>}
    </div>
  )
}

// ── Step 2: Hype — What makes us different ─────────

function S2() {
  return (
    <div>
      <div style={{ background: 'linear-gradient(135deg,#fef3c7,#fffbeb)', border: '3px solid #f59e0b', borderRadius: '18px', padding: '24px 22px' }}>
        <p style={{ fontSize: '13px', fontWeight: 800, color: '#d97706', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '10px' }}>WHY WE&apos;RE DIFFERENT</p>
        <h3 style={{ fontSize: '22px', fontWeight: 800, color: '#92400e', lineHeight: 1.3, marginBottom: '16px' }}>
          This isn&apos;t a denture factory. This is a world-class cosmetic implant center.
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '14px' }}>
          {[
            ['🏆', '1,500+ full-arch cases completed', 'Not 50. Not 200. Over fifteen hundred patients got their smile back here.'],
            ['🖨️', 'Same-day 3D-printed teeth', 'Your new teeth are designed and printed in our in-house lab while you\'re here. No waiting weeks.'],
            ['💎', 'Thin, natural-looking teeth (FP1)', 'None of that bulky "denture look." These are thin, beautiful, cosmetic-grade teeth that look REAL.'],
            ['🔬', 'Full digital workflow', 'CT scans, digital smile design, guided surgery. Pinpoint precision, not guesswork.'],
            ['🦴', 'Bone & gum regeneration specialist', 'Told you don\'t have enough bone? We can build it. Most "hopeless" cases can be treated.'],
            ['😴', 'Minimally invasive + sedation', 'Smaller incisions, faster healing. You sleep through it and wake up with teeth.'],
          ].map(([icon, title, desc], i) => (
            <div key={i} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
              <span style={{ fontSize: '24px', flexShrink: 0 }}>{icon}</span>
              <div>
                <p style={{ fontSize: '15px', fontWeight: 700, color: '#78350f' }}>{title}</p>
                <p style={{ fontSize: '14px', color: '#92400e', lineHeight: 1.5, marginTop: '2px' }}>{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', marginTop: '16px' }}>
        {[['1,500+','Cases Done'],['Same Day','New Teeth'],['In-House','Lab & Design']].map(([n,l],i) => (
          <div key={i} style={{ background: '#fff', border: '2px solid #e5e0d8', borderRadius: '14px', padding: '14px 8px', textAlign: 'center' }}>
            <div style={{ fontSize: '22px', fontWeight: 800, color: '#d97706' }}>{n}</div>
            <div style={{ fontSize: '12px', color: '#78716c', marginTop: '2px' }}>{l}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: '16px', background: '#fff', border: '2px solid #fbbf24', borderRadius: '14px', padding: '16px 18px' }}>
        <p style={{ fontSize: '15px', fontStyle: 'italic', color: '#92400e', lineHeight: 1.6 }}>
          &ldquo;I went to 3 other places. ClearChoice, Affordable Dentures, a local guy. Nobody came close to what Dr. Samadian did. My teeth look like a movie star&apos;s. I&apos;m 71 and I get compliments every day.&rdquo;
        </p>
        <p style={{ fontSize: '13px', color: '#b45309', marginTop: '8px', fontWeight: 600 }}>— Robert M., retired trucker, Costco member since &apos;98</p>
      </div>
    </div>
  )
}

// ── Step 3: Previous Consults ──────────────────────

function S3({ data, u }: { data: FormData; u: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <Heading>Have you looked into implants before?</Heading>
      <Sub>Lots of people have. No judgment — we just want to get you across the finish line.</Sub>
      <Stack>
        <Pill selected={data.previous_consults === 'yes_multi'} onClick={() => u('previous_consults', 'yes_multi')}>Yeah, been to a couple places</Pill>
        <Pill selected={data.previous_consults === 'yes_one'} onClick={() => u('previous_consults', 'yes_one')}>Went to one place but didn&apos;t do it</Pill>
        <Pill selected={data.previous_consults === 'no'} onClick={() => u('previous_consults', 'no')} badge="NO WORRIES">First time looking</Pill>
      </Stack>
      {(data.previous_consults === 'yes_multi' || data.previous_consults === 'yes_one') && <>
        <Label>Where did you go?</Label>
        <Input value={data.previous_consult_locations} onChange={(v) => u('previous_consult_locations', v)} placeholder="ClearChoice, Aspen, a local dentist..." />
        <Label>What stopped you?</Label>
        <Stack>
          <Pill selected={data.what_held_back === 'price'} onClick={() => u('what_held_back', 'price')} badge="WE CAN BEAT IT">Way too expensive</Pill>
          <Pill selected={data.what_held_back === 'denied'} onClick={() => u('what_held_back', 'denied')}>Couldn&apos;t get financing</Pill>
          <Pill selected={data.what_held_back === 'trust'} onClick={() => u('what_held_back', 'trust')}>Didn&apos;t trust the doctor</Pill>
          <Pill selected={data.what_held_back === 'scared'} onClick={() => u('what_held_back', 'scared')}>Nervous about the surgery</Pill>
          <Pill selected={data.what_held_back === 'bone'} onClick={() => u('what_held_back', 'bone')}>They said I don&apos;t have enough bone</Pill>
          <Pill selected={data.what_held_back === 'time'} onClick={() => u('what_held_back', 'time')}>Needed time to think</Pill>
        </Stack>
      </>}
    </div>
  )
}

// ── Step 4: Hype — Smash objections ────────────────

function S4() {
  const held = typeof window !== 'undefined' ? (window as any).__li_held_back : null
  return (
    <div>
      <div style={{ background: 'linear-gradient(135deg,#fef3c7,#fffbeb)', border: '3px solid #f59e0b', borderRadius: '18px', padding: '24px 22px' }}>
        <p style={{ fontSize: '13px', fontWeight: 800, color: '#dc2626', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '10px' }}>REAL TALK</p>
        <h3 style={{ fontSize: '22px', fontWeight: 800, color: '#92400e', lineHeight: 1.3, marginBottom: '16px' }}>
          Whatever stopped you before — we&apos;ve solved it.
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '16px' }}>
          <div style={{ background: '#fff', border: '2px solid #fbbf24', borderRadius: '14px', padding: '14px 16px' }}>
            <p style={{ fontSize: '14px', fontWeight: 700, color: '#dc2626' }}>&ldquo;It&apos;s too expensive&rdquo;</p>
            <p style={{ fontSize: '14px', color: '#78350f', marginTop: '4px', lineHeight: 1.5 }}>We&apos;re not a chain charging $40K for TV ads. In-house lab = no middleman. You get world-class work without the crazy markup.</p>
          </div>
          <div style={{ background: '#fff', border: '2px solid #fbbf24', borderRadius: '14px', padding: '14px 16px' }}>
            <p style={{ fontSize: '14px', fontWeight: 700, color: '#dc2626' }}>&ldquo;I couldn&apos;t get approved&rdquo;</p>
            <p style={{ fontSize: '14px', color: '#78350f', marginTop: '4px', lineHeight: 1.5 }}>We work with 6+ lenders. If one says no, we try the next. 85%+ approval rate. Co-signers welcome. We WILL find a way.</p>
          </div>
          <div style={{ background: '#fff', border: '2px solid #fbbf24', borderRadius: '14px', padding: '14px 16px' }}>
            <p style={{ fontSize: '14px', fontWeight: 700, color: '#dc2626' }}>&ldquo;Not enough bone&rdquo;</p>
            <p style={{ fontSize: '14px', color: '#78350f', marginTop: '4px', lineHeight: 1.5 }}>Dr. Samadian specializes in bone regeneration. Cases other doctors call &ldquo;impossible&rdquo;? We do them every week. Over 1,500 cases and counting.</p>
          </div>
          <div style={{ background: '#fff', border: '2px solid #fbbf24', borderRadius: '14px', padding: '14px 16px' }}>
            <p style={{ fontSize: '14px', fontWeight: 700, color: '#dc2626' }}>&ldquo;I&apos;m scared of the pain&rdquo;</p>
            <p style={{ fontSize: '14px', color: '#78350f', marginTop: '4px', lineHeight: 1.5 }}>Minimally invasive technique + IV sedation. You literally sleep through it. Most patients say it was easier than getting a filling. Wake up with teeth.</p>
          </div>
        </div>
      </div>
      <div style={{ marginTop: '16px', background: '#fff', border: '2px solid #fbbf24', borderRadius: '14px', padding: '16px 18px' }}>
        <p style={{ fontSize: '15px', fontStyle: 'italic', color: '#92400e', lineHeight: 1.6 }}>
          &ldquo;Three dentists told me I couldn&apos;t get implants because of bone loss. Dr. Samadian said &apos;I can fix that.&apos; Six months later I have the most beautiful teeth of my life. I&apos;m 68 years old and I finally smile in photos.&rdquo;
        </p>
        <p style={{ fontSize: '13px', color: '#b45309', marginTop: '8px', fontWeight: 600 }}>— Patricia W., 68, grandmother of 5</p>
      </div>
    </div>
  )
}

// ── Step 5: Urgency + Pain ─────────────────────────

function S5({ data, u }: { data: FormData; u: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <Heading>Real talk — how bad is it right now?</Heading>
      <Sub>No judgment. We&apos;ve heard it all.</Sub>
      <Label>What bothers you the most?</Label>
      <Stack>
        <Pill selected={data.pain_level === 'pain'} onClick={() => u('pain_level', 'pain')} badge="URGENT">I&apos;m in pain every day</Pill>
        <Pill selected={data.pain_level === 'cant_eat'} onClick={() => u('pain_level', 'cant_eat')}>I can&apos;t eat the foods I love</Pill>
        <Pill selected={data.pain_level === 'embarrassed'} onClick={() => u('pain_level', 'embarrassed')}>I don&apos;t smile anymore — it&apos;s embarrassing</Pill>
        <Pill selected={data.pain_level === 'dentures'} onClick={() => u('pain_level', 'dentures')}>My dentures make me miserable</Pill>
        <Pill selected={data.pain_level === 'all'} onClick={() => u('pain_level', 'all')}>Honestly? All of the above</Pill>
      </Stack>
      <Label>If the price and timing were right — would you do this?</Label>
      <Stack>
        <Pill selected={data.urgency === 'asap'} onClick={() => u('urgency', 'asap')} badge="BEST PRICING">Yes — I&apos;ve waited long enough</Pill>
        <Pill selected={data.urgency === 'soon'} onClick={() => u('urgency', 'soon')}>Within the next couple months</Pill>
        <Pill selected={data.urgency === 'depends'} onClick={() => u('urgency', 'depends')}>Depends on the cost</Pill>
        <Pill selected={data.urgency === 'procrastinating'} onClick={() => u('urgency', 'procrastinating')}>I keep putting it off 😅</Pill>
      </Stack>
    </div>
  )
}

// ── Step 6: Financing ──────────────────────────────

function S6({ data, u }: { data: FormData; u: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <Heading>Let&apos;s figure out the money part</Heading>
      <Sub>Almost everyone uses payments. We make it work — 85% approval rate.</Sub>
      <Label>Any idea on your credit score?</Label>
      <Stack>
        <Pill selected={data.credit_score_range === '720'} onClick={() => u('credit_score_range', '720')} badge="0% INTEREST">Good — 720+</Pill>
        <Pill selected={data.credit_score_range === '680'} onClick={() => u('credit_score_range', '680')}>Decent — 680-719</Pill>
        <Pill selected={data.credit_score_range === '600'} onClick={() => u('credit_score_range', '600')}>Fair — 600-679</Pill>
        <Pill selected={data.credit_score_range === 'low'} onClick={() => u('credit_score_range', 'low')}>Under 600</Pill>
        <Pill selected={data.credit_score_range === 'idk'} onClick={() => u('credit_score_range', 'idk')}>No clue</Pill>
      </Stack>
      <Label>What monthly payment could you handle?</Label>
      <Stack>
        <Pill selected={data.monthly_payment_range === 'under200'} onClick={() => u('monthly_payment_range', 'under200')}>Under $200/mo</Pill>
        <Pill selected={data.monthly_payment_range === '200_350'} onClick={() => u('monthly_payment_range', '200_350')} badge="MOST POPULAR">$200-$350/mo</Pill>
        <Pill selected={data.monthly_payment_range === '350_500'} onClick={() => u('monthly_payment_range', '350_500')}>$350-$500/mo</Pill>
        <Pill selected={data.monthly_payment_range === '500'} onClick={() => u('monthly_payment_range', '500')}>$500+/mo or cash</Pill>
        <Pill selected={data.monthly_payment_range === 'help'} onClick={() => u('monthly_payment_range', 'help')}>I need to talk it over</Pill>
      </Stack>
      <Label>Could a spouse or family member co-sign?</Label>
      <Sub>A co-signer = better rates + higher approval chance.</Sub>
      <Stack>
        <Pill selected={data.has_cosigner === 'yes'} onClick={() => u('has_cosigner', 'yes')}>Yes</Pill>
        <Pill selected={data.has_cosigner === 'maybe'} onClick={() => u('has_cosigner', 'maybe')}>Maybe — I&apos;d have to ask</Pill>
        <Pill selected={data.has_cosigner === 'no'} onClick={() => u('has_cosigner', 'no')}>No, just me</Pill>
        <Pill selected={data.has_cosigner === 'cash'} onClick={() => u('has_cosigner', 'cash')}>Paying cash</Pill>
      </Stack>
    </div>
  )
}

// ── Step 7: Hype — Final push ──────────────────────

function S7() {
  return (
    <div>
      <div style={{ background: 'linear-gradient(135deg,#fef3c7,#fffbeb)', border: '3px solid #f59e0b', borderRadius: '18px', padding: '24px 22px' }}>
        <p style={{ fontSize: '13px', fontWeight: 800, color: '#16a34a', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '10px' }}>ALMOST DONE!</p>
        <h3 style={{ fontSize: '22px', fontWeight: 800, color: '#92400e', lineHeight: 1.3, marginBottom: '16px' }}>
          Here&apos;s what you&apos;re getting — 100% FREE
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '12px' }}>
          {[
            ['✅', 'FREE 3D CT Scan', '(normally $500+)'],
            ['✅', 'FREE Digital Smile Design', 'See your new teeth BEFORE you commit'],
            ['✅', 'FREE Custom Treatment Plan', 'With exact pricing — no surprises'],
            ['✅', 'FREE Financing Pre-Approval', 'Know your monthly payment upfront'],
            ['✅', 'Meet Dr. Samadian Personally', '1,500+ cases. TMJ & Sleep Apnea specialist'],
          ].map(([icon, title, desc], i) => (
            <div key={i} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
              <span style={{ fontSize: '20px', flexShrink: 0 }}>{icon}</span>
              <div>
                <span style={{ fontSize: '15px', fontWeight: 700, color: '#78350f' }}>{title} </span>
                <span style={{ fontSize: '14px', color: '#92400e' }}>{desc}</span>
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: '20px', background: '#dc2626', borderRadius: '12px', padding: '14px 18px', textAlign: 'center' }}>
          <p style={{ fontSize: '16px', fontWeight: 800, color: '#fff' }}>TOTAL VALUE: Over $1,200 — yours FREE</p>
          <p style={{ fontSize: '13px', color: '#fecaca', marginTop: '4px' }}>No catch. No commitment. Walk away if you want.</p>
        </div>
      </div>
      <div style={{ marginTop: '16px', background: '#fff', border: '2px solid #fbbf24', borderRadius: '14px', padding: '16px 18px' }}>
        <p style={{ fontSize: '15px', fontStyle: 'italic', color: '#92400e', lineHeight: 1.6 }}>
          &ldquo;I was SO nervous walking in. The second I met Dr. Samadian I knew I was in the right place. He showed me exactly what my smile would look like on a screen. I started crying happy tears. That was 2 years ago — best decision of my life.&rdquo;
        </p>
        <p style={{ fontSize: '13px', color: '#b45309', marginTop: '8px', fontWeight: 600 }}>— Linda K., 65, grandmother of 4</p>
      </div>
    </div>
  )
}

// ── Step 8: Contact ────────────────────────────────

function S8({ data, u }: { data: FormData; u: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <Heading>Last step — where should we call you?</Heading>
      <Sub>A real person (not a robot) will call to set up your <strong>FREE visit</strong> with Dr. Samadian.</Sub>
      <Stack gap={14}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>First Name *</label>
            <Input value={data.first_name} onChange={(v) => u('first_name', v)} placeholder="First name" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>Last Name</label>
            <Input value={data.last_name} onChange={(v) => u('last_name', v)} placeholder="Last name" />
          </div>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>Phone Number *</label>
          <Input value={data.phone} onChange={(v) => u('phone', v)} placeholder="(555) 123-4567" type="tel" highlight note="We'll call or text to schedule your FREE consultation" />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>Email (optional)</label>
          <Input value={data.email} onChange={(v) => u('email', v)} placeholder="your@email.com" type="email" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>City</label>
            <Input value={data.city} onChange={(v) => u('city', v)} placeholder="Your city" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>State</label>
            <input value={data.state} onChange={(e) => u('state', e.target.value)} placeholder="CA" maxLength={2}
              style={{ width: '100%', padding: '15px 18px', fontSize: '17px', border: '3px solid #e5e0d8', borderRadius: '14px', outline: 'none', background: '#fff', color: '#1f1a15', boxSizing: 'border-box' as const }} />
          </div>
        </div>
      </Stack>
      <div style={{ marginTop: '20px', background: '#f0fdf4', border: '2px solid #bbf7d0', borderRadius: '14px', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '22px' }}>🔒</span>
        <p style={{ fontSize: '13px', color: '#166534' }}><strong>100% private.</strong> We NEVER sell your info. That&apos;s a promise.</p>
      </div>
    </div>
  )
}

// ── Success ────────────────────────────────────────

function Success({ score, data }: { score: ScoreResult; data: FormData }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: '#f0fdf4', border: '3px solid #bbf7d0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '20px' }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
      </div>
      <h2 style={{ fontSize: '26px', fontWeight: 800, color: '#1f1a15', marginBottom: '8px' }}>You did it, {data.first_name}! 🎉</h2>
      <div style={{ background: 'linear-gradient(135deg,#fef3c7,#fffbeb)', border: '3px solid #f59e0b', borderRadius: '18px', padding: '22px', margin: '16px 0' }}>
        {score ? <>
          <p style={{ fontSize: '16px', fontWeight: 700, color: '#92400e', marginBottom: '8px' }}>
            {score.qualification === 'hot' ? 'EXCELLENT — you look like a GREAT candidate!' : score.qualification === 'warm' ? 'Looking good! You could be a strong candidate.' : 'Thanks for the info!'}
          </p>
          <div style={{ fontSize: '48px', fontWeight: 800, color: '#d97706' }}>{score.total}<span style={{ fontSize: '22px', color: '#b45309' }}>/100</span></div>
          <p style={{ fontSize: '13px', color: '#92400e', marginTop: '4px' }}>Match Score</p>
        </> : <p style={{ fontSize: '16px', fontWeight: 700, color: '#92400e' }}>Your assessment is complete!</p>}
      </div>
      <p style={{ fontSize: '16px', color: '#57534e', lineHeight: 1.6, marginBottom: '20px' }}>
        A real person will <strong>call or text you at {data.phone}</strong> within 24 hours to schedule your FREE consultation with Dr. Samadian.
      </p>
      <div style={{ background: '#fff', border: '3px solid #e5e0d8', borderRadius: '18px', padding: '22px', textAlign: 'left' }}>
        <p style={{ fontSize: '12px', fontWeight: 700, color: '#78716c', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '14px' }}>WHAT HAPPENS NEXT</p>
        {['We call you to pick a time', 'FREE consult + 3D CT scan with Dr. Samadian', 'See your new smile designed on screen', 'If you love it — new teeth that same week'].map((t, i) => (
          <div key={i} style={{ display: 'flex', gap: '12px', marginBottom: '10px', alignItems: 'flex-start' }}>
            <span style={{ width: '26px', height: '26px', borderRadius: '50%', background: '#d97706', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 700, flexShrink: 0 }}>{i + 1}</span>
            <span style={{ fontSize: '15px', color: '#44403c' }}>{t}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Progress Bar ───────────────────────────────────

function Progress({ current, total }: { current: number; total: number }) {
  const p = Math.round((current / total) * 100)
  return (
    <div style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 600, color: '#78716c', marginBottom: '6px' }}>
        <span>{current} of {total}</span><span>{p}%</span>
      </div>
      <div style={{ height: '10px', borderRadius: '99px', background: '#e5e0d8', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: '99px', background: 'linear-gradient(90deg,#d97706,#f59e0b)', width: `${p}%`, transition: 'width .5s ease' }} />
      </div>
    </div>
  )
}

// ── Main Export ─────────────────────────────────────

export function QualificationFormSamadian({ orgId, orgName, apiBase = '', utmParams = {} }: { orgId: string; orgName?: string; apiBase?: string; utmParams?: Record<string, string> }) {
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [score, setScore] = useState<ScoreResult>(null)
  const [data, setData] = useState<FormData>({
    teeth_situation: '', teeth_count_upper: '', teeth_count_lower: '', has_dentures: '',
    previous_consults: '', previous_consult_locations: '', what_held_back: '',
    urgency: '', pain_level: '', credit_score_range: '', monthly_payment_range: '', has_cosigner: '',
    first_name: '', last_name: '', phone: '', email: '', city: '', state: '',
  })

  const u = useCallback((f: keyof FormData, v: string) => setData((p) => ({ ...p, [f]: v })), [])
  const cfg = STEPS[step - 1]
  const ok = cfg?.canProceed(data) ?? false

  async function submit() {
    setBusy(true)
    try {
      const map: Record<string, string> = { no_teeth: 'missing_all_both', failing: 'failing_teeth', dentures: 'denture_problems', some_missing: 'missing_multiple', not_sure: 'other' }
      const payload = {
        first_name: data.first_name, last_name: data.last_name || undefined, phone: data.phone, email: data.email || undefined,
        city: data.city || undefined, state: data.state || undefined,
        dental_condition: map[data.teeth_situation] || 'other',
        dental_condition_details: [`Teeth:${data.teeth_situation}`, `Upper:${data.teeth_count_upper}`, `Lower:${data.teeth_count_lower}`,
          data.previous_consults !== 'no' ? `Prev:${data.previous_consult_locations||data.previous_consults}` : '', data.what_held_back ? `Block:${data.what_held_back}` : '',
          `Pain:${data.pain_level}`, `Credit:${data.credit_score_range}`, `Mo:${data.monthly_payment_range}`, `Cosign:${data.has_cosigner}`].filter(Boolean).join('|'),
        has_dentures: data.teeth_situation === 'dentures', urgency: data.urgency,
        financing_interest: data.has_cosigner === 'cash' ? 'cash_pay' : 'financing_needed', has_dental_insurance: false,
        budget_range: data.monthly_payment_range === '500' ? 'over_30k' : data.monthly_payment_range === '350_500' ? '20k_25k' : data.monthly_payment_range === '200_350' ? '15k_20k' : '10k_15k',
        source_type: utmParams.source_type || 'landing_page', utm_source: utmParams.utm_source || undefined, utm_medium: utmParams.utm_medium || undefined,
        utm_campaign: utmParams.utm_campaign || undefined, gclid: utmParams.gclid || undefined, fbclid: utmParams.fbclid || undefined,
        landing_page_url: typeof window !== 'undefined' ? window.location.href : undefined,
      }
      const r = await fetch(`${apiBase}/api/webhooks/qualify?org=${orgId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!r.ok) throw new Error('fail')
      const res = await r.json(); setScore(res.score); setDone(true)
      if (typeof window !== 'undefined') { (window as any).gtag?.('event', 'conversion', { send_to: 'lead_qualification_complete' }); (window as any).fbq?.('track', 'Lead') }
    } catch { alert('Something went wrong. Please call us directly.') }
    finally { setBusy(false) }
  }

  if (done) return <div style={{ maxWidth: '520px', margin: '0 auto', padding: '20px' }}><Success score={score} data={data} /></div>

  return (
    <div style={{ maxWidth: '520px', margin: '0 auto', padding: '12px 16px' }}>
      <Progress current={step} total={STEPS.length} />
      <div style={{ minHeight: '400px' }}>
        {step===1&&<S1 data={data} u={u}/>}{step===2&&<S2/>}{step===3&&<S3 data={data} u={u}/>}{step===4&&<S4/>}
        {step===5&&<S5 data={data} u={u}/>}{step===6&&<S6 data={data} u={u}/>}{step===7&&<S7/>}{step===8&&<S8 data={data} u={u}/>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '28px', paddingBottom: '16px' }}>
        {step > 1 ? <button type="button" onClick={() => setStep((s) => s - 1)} style={{ fontSize: '15px', fontWeight: 600, color: '#78716c', background: 'none', border: 'none', cursor: 'pointer' }}>← Back</button> : <div/>}
        <button type="button" onClick={() => step === STEPS.length ? submit() : setStep((s) => s + 1)} disabled={!ok || busy} style={{
          padding: '16px 32px', fontSize: '17px', fontWeight: 800, borderRadius: '14px', border: 'none',
          cursor: ok && !busy ? 'pointer' : 'not-allowed',
          background: ok && !busy ? 'linear-gradient(135deg,#d97706,#b45309)' : '#e5e0d8',
          color: ok && !busy ? '#fff' : '#a8a29e',
          boxShadow: ok && !busy ? '0 4px 14px rgba(217,119,6,.3)' : 'none',
          transition: 'all .15s', width: step > 1 ? 'auto' : '100%', minWidth: '200px',
        }}>
          {busy ? 'Checking...' : step === STEPS.length ? 'SEE MY RESULTS →' : cfg?.type === 'hype' ? 'KEEP GOING →' : 'NEXT →'}
        </button>
      </div>
    </div>
  )
}
