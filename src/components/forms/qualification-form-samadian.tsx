'use client'

import { useState, useCallback } from 'react'

type FormData = {
  teeth_situation: string
  teeth_count_upper: string
  teeth_count_lower: string
  previous_consults: string
  previous_consult_locations: string
  what_held_back: string[]
  urgency: string
  pain_level: string[]
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

type ScoreResult = { total: number; qualification: 'hot' | 'warm' | 'cold' | 'unqualified'; summary: string; recommended_action: string } | null
type StepConfig = { type: 'q' | 'h'; ok: (d: FormData) => boolean }

// 12 steps: question → hype → question → hype → question → hype → question → hype → question → hype → contact → (submit)
const STEPS: StepConfig[] = [
  { type: 'q', ok: (d) => !!d.teeth_situation },                              // 1: teeth
  { type: 'h', ok: () => true },                                               // 2: hype — same day 3D printed
  { type: 'q', ok: (d) => !!d.previous_consults },                            // 3: prev consults
  { type: 'h', ok: () => true },                                               // 4: hype — not clearchoice / bone regen
  { type: 'q', ok: (d) => d.pain_level.length > 0 },                            // 5: pain / what bothers you (multi)
  { type: 'h', ok: () => true },                                               // 6: hype — 1500 cases / FP1 cosmetic
  { type: 'q', ok: (d) => !!d.urgency },                                      // 7: urgency / ready?
  { type: 'h', ok: () => true },                                               // 8: hype — financing / 85% approved
  { type: 'q', ok: (d) => !!d.credit_score_range && !!d.monthly_payment_range }, // 9: credit + payments
  { type: 'h', ok: () => true },                                               // 10: hype — FREE consult value stack
  { type: 'q', ok: (d) => !!d.first_name && !!d.phone && d.phone.replace(/\D/g, '').length >= 7 && !!d.email && d.email.includes('@') }, // 11: contact (email required)
]

// ── Shared ────────────────────────────────────────

function Pill({ sel, click, children, tag }: { sel: boolean; click: () => void; children: React.ReactNode; tag?: string }) {
  return (
    <button type="button" onClick={click} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: '14px', padding: '16px 18px',
      borderRadius: '14px', border: `3px solid ${sel ? '#d97706' : '#e5e0d8'}`,
      background: sel ? '#fffbeb' : '#fff', cursor: 'pointer', transition: 'all .15s',
      boxShadow: sel ? '0 0 0 1px #d97706' : 'none', textAlign: 'left' as const,
    }}>
      <span style={{ width: '24px', height: '24px', borderRadius: '50%', border: `3px solid ${sel ? '#d97706' : '#ccc'}`,
        background: sel ? '#d97706' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {sel && <svg width="12" height="12" viewBox="0 0 12 12" fill="#fff"><path d="M10.28 2.28L3.989 8.575 1.695 6.28A1 1 0 00.28 7.695l3 3a1 1 0 001.414 0l7-7A1 1 0 0010.28 2.28z"/></svg>}
      </span>
      <span style={{ fontSize: '16px', fontWeight: 600, color: '#1f1a15', lineHeight: 1.4, flex: 1 }}>{children}</span>
      {tag && <span style={{ background: tag === 'MOST COMMON' || tag === 'MOST POPULAR' || tag === '0% INTEREST' ? '#d97706' : '#dc2626', color: '#fff', fontSize: '10px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px', textTransform: 'uppercase' as const, letterSpacing: '.5px', whiteSpace: 'nowrap' as const }}>{tag}</span>}
    </button>
  )
}
function MultiPill({ sel, click, children, tag }: { sel: boolean; click: () => void; children: React.ReactNode; tag?: string }) {
  return (
    <button type="button" onClick={click} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: '14px', padding: '16px 18px',
      borderRadius: '14px', border: `3px solid ${sel ? '#d97706' : '#e5e0d8'}`,
      background: sel ? '#fffbeb' : '#fff', cursor: 'pointer', transition: 'all .15s',
      boxShadow: sel ? '0 0 0 1px #d97706' : 'none', textAlign: 'left' as const,
    }}>
      <span style={{ width: '24px', height: '24px', borderRadius: '6px', border: `3px solid ${sel ? '#d97706' : '#ccc'}`,
        background: sel ? '#d97706' : '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {sel && <svg width="12" height="12" viewBox="0 0 12 12" fill="#fff"><path d="M10.28 2.28L3.989 8.575 1.695 6.28A1 1 0 00.28 7.695l3 3a1 1 0 001.414 0l7-7A1 1 0 0010.28 2.28z"/></svg>}
      </span>
      <span style={{ fontSize: '16px', fontWeight: 600, color: '#1f1a15', lineHeight: 1.4, flex: 1 }}>{children}</span>
      {tag && <span style={{ background: '#dc2626', color: '#fff', fontSize: '10px', fontWeight: 800, padding: '2px 7px', borderRadius: '5px', textTransform: 'uppercase' as const, letterSpacing: '.5px', whiteSpace: 'nowrap' as const }}>{tag}</span>}
    </button>
  )
}

function H({ children }: { children: React.ReactNode }) { return <h2 style={{ fontSize: '24px', fontWeight: 800, color: '#1f1a15', lineHeight: 1.3, marginBottom: '6px' }}>{children}</h2> }
function P({ children }: { children: React.ReactNode }) { return <p style={{ fontSize: '15px', color: '#78716c', marginBottom: '22px', lineHeight: 1.5 }}>{children}</p> }
function L({ children }: { children: React.ReactNode }) { return <p style={{ fontSize: '15px', fontWeight: 700, color: '#1f1a15', marginBottom: '14px', marginTop: '24px' }}>{children}</p> }

function Hype({ tag, headline, body, quote, quoteBy, bigStat, bigLabel, cta }: {
  tag: string; headline: string; body: string; quote?: string; quoteBy?: string
  bigStat?: string; bigLabel?: string; cta?: string
}) {
  return (
    <div>
      <div style={{ background: 'linear-gradient(135deg,#fef3c7,#fffbeb)', border: '3px solid #f59e0b', borderRadius: '18px', padding: '24px 22px' }}>
        <p style={{ fontSize: '12px', fontWeight: 800, color: '#d97706', textTransform: 'uppercase' as const, letterSpacing: '1.5px', marginBottom: '12px' }}>{tag}</p>
        <h3 style={{ fontSize: '21px', fontWeight: 800, color: '#92400e', lineHeight: 1.35, marginBottom: '14px' }}>{headline}</h3>
        <p style={{ fontSize: '16px', color: '#78350f', lineHeight: 1.7 }}>{body}</p>
        {quote && (
          <div style={{ marginTop: '18px', background: '#fff', border: '2px solid #fbbf24', borderRadius: '14px', padding: '14px 18px' }}>
            <p style={{ fontSize: '15px', fontStyle: 'italic', color: '#92400e', lineHeight: 1.6 }}>&ldquo;{quote}&rdquo;</p>
            {quoteBy && <p style={{ fontSize: '13px', color: '#b45309', marginTop: '6px', fontWeight: 600 }}>— {quoteBy}</p>}
          </div>
        )}
      </div>
      {(bigStat || cta) && (
        <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
          {bigStat && (
            <div style={{ flex: '0 0 auto', background: '#fff', border: '2px solid #e5e0d8', borderRadius: '14px', padding: '14px 20px', textAlign: 'center' as const }}>
              <div style={{ fontSize: '28px', fontWeight: 800, color: '#d97706' }}>{bigStat}</div>
              <div style={{ fontSize: '12px', color: '#78716c', marginTop: '2px' }}>{bigLabel}</div>
            </div>
          )}
          {cta && (
            <div style={{ flex: 1, background: '#dc2626', borderRadius: '14px', padding: '14px 18px', display: 'flex', alignItems: 'center' }}>
              <p style={{ fontSize: '15px', fontWeight: 700, color: '#fff', lineHeight: 1.4 }}>{cta}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Step 1: Teeth ─────────────────────────────────

function Q1({ d, u }: { d: FormData; u: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <div style={{ background: '#dc2626', color: '#fff', textAlign: 'center', padding: '10px', borderRadius: '12px', marginBottom: '20px', fontSize: '13px', fontWeight: 700, letterSpacing: '.5px' }}>
        ⚡ ONLY 7 FREE CONSULTATION SPOTS LEFT THIS MONTH
      </div>
      <H>Quick question — what&apos;s going on with your teeth?</H>
      <P>Tap the one that sounds like you. Takes 2 minutes.</P>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '10px' }}>
        <Pill sel={d.teeth_situation==='none'} click={() => u('teeth_situation','none')}>I&apos;ve lost all or almost all my teeth</Pill>
        <Pill sel={d.teeth_situation==='dentures'} click={() => u('teeth_situation','dentures')} tag="MOST COMMON">I wear dentures and I&apos;m DONE with them</Pill>
        <Pill sel={d.teeth_situation==='failing'} click={() => u('teeth_situation','failing')}>My teeth are falling apart</Pill>
        <Pill sel={d.teeth_situation==='missing'} click={() => u('teeth_situation','missing')}>I&apos;m missing a bunch of teeth</Pill>
        <Pill sel={d.teeth_situation==='smile'} click={() => u('teeth_situation','smile')}>I just want to smile and eat again</Pill>
      </div>
      {d.teeth_situation && <>
        <L>How many real teeth left on top?</L>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '8px' }}>
          {[['zero','None'],['few','A few (1-5)'],['some','6 or more'],['idk','Not sure']].map(([v,l]) =>
            <Pill key={v} sel={d.teeth_count_upper===v} click={() => u('teeth_count_upper',v)}>{l}</Pill>)}
        </div>
        <L>And on the bottom?</L>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '8px' }}>
          {[['zero','None'],['few','A few (1-5)'],['some','6 or more'],['idk','Not sure']].map(([v,l]) =>
            <Pill key={v} sel={d.teeth_count_lower===v} click={() => u('teeth_count_lower',v)}>{l}</Pill>)}
        </div>
      </>}
    </div>
  )
}

// ── Step 2: Hype — Same-day 3D Printed ────────────

function H2() {
  return <Hype
    tag="DID YOU KNOW?"
    headline="You can walk in with NO teeth and walk out the SAME DAY with a brand new smile"
    body="Not a denture. Not a temporary. Your new permanent teeth are 3D-printed right here in our in-house lab while you're in the chair. No waiting weeks for some outside lab. You leave smiling."
    quote="I walked in with broken teeth and walked out 4 hours later biting into a sandwich. I'm not joking. Same day."
    quoteBy="James T., 63"
    bigStat="Same Day" bigLabel="3D-Printed Teeth"
    cta="Keep going — let's see if you're a candidate →"
  />
}

// ── Step 3: Previous Consults ──────────────────────

function Q3({ d, u, toggle }: { d: FormData; u: (f: keyof FormData, v: string) => void; toggle: (f: 'pain_level' | 'what_held_back', v: string) => void }) {
  return (
    <div>
      <H>Have you looked into implants before?</H>
      <P>Be honest — lots of people have. That&apos;s normal.</P>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '10px' }}>
        <Pill sel={d.previous_consults==='multi'} click={() => u('previous_consults','multi')}>Yeah, been to a few places</Pill>
        <Pill sel={d.previous_consults==='one'} click={() => u('previous_consults','one')}>One place, but didn&apos;t do it</Pill>
        <Pill sel={d.previous_consults==='no'} click={() => u('previous_consults','no')} tag="NO WORRIES">First time looking</Pill>
      </div>
      {(d.previous_consults==='multi'||d.previous_consults==='one') && <>
        <L>Where did you go?</L>
        <input value={d.previous_consult_locations} onChange={(e) => u('previous_consult_locations',e.target.value)} placeholder="ClearChoice, Aspen, local dentist..."
          style={{ width: '100%', padding: '15px 18px', fontSize: '17px', border: '3px solid #e5e0d8', borderRadius: '14px', outline: 'none', background: '#fff', color: '#1f1a15', boxSizing: 'border-box' as const }} />
        <L>What stopped you? (select all that apply)</L>
        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '8px' }}>
          <MultiPill sel={d.what_held_back.includes('price')} click={() => toggle('what_held_back','price')} tag="WE CAN BEAT IT">Too expensive</MultiPill>
          <MultiPill sel={d.what_held_back.includes('denied')} click={() => toggle('what_held_back','denied')}>Couldn&apos;t get financed</MultiPill>
          <MultiPill sel={d.what_held_back.includes('bone')} click={() => toggle('what_held_back','bone')} tag="WE FIX THIS">They said not enough bone</MultiPill>
          <MultiPill sel={d.what_held_back.includes('trust')} click={() => toggle('what_held_back','trust')}>Didn&apos;t trust the doctor</MultiPill>
          <MultiPill sel={d.what_held_back.includes('scared')} click={() => toggle('what_held_back','scared')}>Too scared</MultiPill>
          <MultiPill sel={d.what_held_back.includes('time')} click={() => toggle('what_held_back','time')}>Needed time</MultiPill>
        </div>
      </>}
    </div>
  )
}

// ── Step 4: Hype — Not ClearChoice + Bone Regen ───

function H4() {
  return <Hype
    tag="REAL TALK"
    headline="We're NOT ClearChoice. And we fix the cases they turn away."
    body="Big chains charge $40K and turn you down if you've lost bone. Dr. Samadian SPECIALIZES in bone and gum regeneration. Cases other doctors call 'impossible'? He does them every single week. Over 1,500 and counting."
    quote="Three dentists said I couldn't get implants. Not enough bone. Dr. Samadian said 'I can fix that.' He did. I have the most beautiful teeth of my life at 68 years old."
    quoteBy="Patricia W., 68"
    bigStat="1,500+" bigLabel="Cases Completed"
    cta="You're doing great — keep going →"
  />
}

// ── Step 5: Pain / What Bothers You ───────────────

function Q5({ d, toggle }: { d: FormData; toggle: (f: 'pain_level' | 'what_held_back', v: string) => void }) {
  return (
    <div>
      <H>What bothers you the most right now?</H>
      <P>Select ALL that apply — be honest.</P>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '10px' }}>
        <MultiPill sel={d.pain_level.includes('pain')} click={() => toggle('pain_level','pain')} tag="URGENT">I&apos;m in pain every day</MultiPill>
        <MultiPill sel={d.pain_level.includes('eat')} click={() => toggle('pain_level','eat')}>I can&apos;t eat the foods I love</MultiPill>
        <MultiPill sel={d.pain_level.includes('embarrassed')} click={() => toggle('pain_level','embarrassed')}>I don&apos;t smile or take photos</MultiPill>
        <MultiPill sel={d.pain_level.includes('dentures')} click={() => toggle('pain_level','dentures')}>My dentures are miserable</MultiPill>
        <MultiPill sel={d.pain_level.includes('social')} click={() => toggle('pain_level','social')}>I avoid going out or dating</MultiPill>
        <MultiPill sel={d.pain_level.includes('health')} click={() => toggle('pain_level','health')}>It&apos;s affecting my health (can&apos;t chew properly)</MultiPill>
      </div>
    </div>
  )
}

// ── Step 6: Hype — FP1 Cosmetic + Minimally Invasive

function H6() {
  return <Hype
    tag="THIS ISN'T YOUR GRANDMA'S DENTURE"
    headline="These are thin, Hollywood-grade cosmetic teeth. Nobody will know they're implants."
    body="Dr. Samadian is a world-class cosmetic dentist. He uses ultra-thin FP1 prosthetics — the same kind celebrities get. They look completely natural. No thick, bulky 'denture look.' Plus, the surgery is minimally invasive — tiny incisions, less swelling, faster healing. You sleep through the whole thing with IV sedation."
    quote="People ask me if I got veneers. They have NO idea these are implants. I smile bigger now at 70 than I did at 30."
    quoteBy="Barbara L., 70"
    bigStat="FP1" bigLabel="Cosmetic Grade"
    cta="Almost there! Just a few more questions →"
  />
}

// ── Step 7: Urgency ───────────────────────────────

function Q7({ d, u }: { d: FormData; u: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <H>If the price and timing were right — would you do this?</H>
      <P>Be honest with yourself. You deserve this.</P>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '10px' }}>
        <Pill sel={d.urgency==='asap'} click={() => u('urgency','asap')} tag="BEST PRICING">Yes — I&apos;ve waited long enough</Pill>
        <Pill sel={d.urgency==='soon'} click={() => u('urgency','soon')}>Within the next couple months</Pill>
        <Pill sel={d.urgency==='depends'} click={() => u('urgency','depends')}>Depends on the cost</Pill>
        <Pill sel={d.urgency==='putting_off'} click={() => u('urgency','putting_off')}>I keep putting it off honestly</Pill>
      </div>
    </div>
  )
}

// ── Step 8: Hype — Financing ──────────────────────

function H8() {
  return <Hype
    tag="MONEY SHOULDN'T STOP YOU"
    headline="85% of our patients get approved for financing. Payments as low as $199/month."
    body="We work with 6+ lenders. If one says no, we try the next one. Co-signers welcome. 0% interest plans available. No penalty for paying early. We WILL find a way to make this work for you."
    quote="I thought there was no way I could afford this. They got me approved in 20 minutes at $250 a month. I wish I'd stopped waiting years ago."
    quoteBy="Robert M., 71"
    bigStat="85%+" bigLabel="Get Approved"
    cta="Let's figure out what works for you →"
  />
}

// ── Step 9: Credit + Payments ─────────────────────

function Q9({ d, u }: { d: FormData; u: (f: keyof FormData, v: string) => void }) {
  return (
    <div>
      <H>Let&apos;s figure out the money part</H>
      <P>Almost everyone uses payments. No shame in that.</P>
      <L>Any idea on your credit score?</L>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '8px' }}>
        <Pill sel={d.credit_score_range==='720'} click={() => u('credit_score_range','720')} tag="0% INTEREST">Good — 720+</Pill>
        <Pill sel={d.credit_score_range==='680'} click={() => u('credit_score_range','680')}>Decent — 680-719</Pill>
        <Pill sel={d.credit_score_range==='600'} click={() => u('credit_score_range','600')}>Fair — 600-679</Pill>
        <Pill sel={d.credit_score_range==='low'} click={() => u('credit_score_range','low')}>Under 600</Pill>
        <Pill sel={d.credit_score_range==='idk'} click={() => u('credit_score_range','idk')}>No idea</Pill>
      </div>
      <L>What monthly payment could you handle?</L>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '8px' }}>
        <Pill sel={d.monthly_payment_range==='u200'} click={() => u('monthly_payment_range','u200')}>Under $200/mo</Pill>
        <Pill sel={d.monthly_payment_range==='200'} click={() => u('monthly_payment_range','200')} tag="MOST POPULAR">$200-$350/mo</Pill>
        <Pill sel={d.monthly_payment_range==='350'} click={() => u('monthly_payment_range','350')}>$350-$500/mo</Pill>
        <Pill sel={d.monthly_payment_range==='500'} click={() => u('monthly_payment_range','500')}>$500+ or cash</Pill>
        <Pill sel={d.monthly_payment_range==='help'} click={() => u('monthly_payment_range','help')}>Need to talk it over</Pill>
      </div>
      <L>Could a spouse or family member co-sign?</L>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '8px' }}>
        <Pill sel={d.has_cosigner==='yes'} click={() => u('has_cosigner','yes')}>Yes</Pill>
        <Pill sel={d.has_cosigner==='maybe'} click={() => u('has_cosigner','maybe')}>Maybe</Pill>
        <Pill sel={d.has_cosigner==='no'} click={() => u('has_cosigner','no')}>No, just me</Pill>
        <Pill sel={d.has_cosigner==='cash'} click={() => u('has_cosigner','cash')}>Paying cash</Pill>
      </div>
    </div>
  )
}

// ── Step 10: Hype — FREE value stack ──────────────

function H10() {
  return (
    <div>
      <div style={{ background: 'linear-gradient(135deg,#fef3c7,#fffbeb)', border: '3px solid #f59e0b', borderRadius: '18px', padding: '24px 22px' }}>
        <p style={{ fontSize: '12px', fontWeight: 800, color: '#16a34a', textTransform: 'uppercase' as const, letterSpacing: '1.5px', marginBottom: '12px' }}>YOU&apos;RE ALMOST DONE!</p>
        <h3 style={{ fontSize: '21px', fontWeight: 800, color: '#92400e', lineHeight: 1.35, marginBottom: '18px' }}>
          Here&apos;s what you get — 100% FREE
        </h3>
        {[
          ['✅','FREE 3D CT Scan','(worth $500+)'],
          ['✅','FREE Digital Smile Design','See your new teeth BEFORE you commit'],
          ['✅','FREE Treatment Plan','Exact pricing, no surprises'],
          ['✅','FREE Financing Pre-Approval','Know your payment upfront'],
          ['✅','Meet Dr. Samadian Personally','1,500+ cases. You\'re in the best hands.'],
        ].map(([icon,title,desc],i) => (
          <div key={i} style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', marginBottom: '10px' }}>
            <span style={{ fontSize: '18px', flexShrink: 0 }}>{icon}</span>
            <span style={{ fontSize: '15px', color: '#78350f', lineHeight: 1.5 }}><strong>{title}</strong> — {desc}</span>
          </div>
        ))}
        <div style={{ marginTop: '18px', background: '#dc2626', borderRadius: '12px', padding: '14px 18px', textAlign: 'center' as const }}>
          <p style={{ fontSize: '16px', fontWeight: 800, color: '#fff' }}>TOTAL VALUE: Over $1,200 — Yours FREE</p>
          <p style={{ fontSize: '13px', color: '#fecaca', marginTop: '4px' }}>No catch. No commitment. Walk away if you want.</p>
        </div>
      </div>
      <div style={{ marginTop: '14px', background: '#fff', border: '2px solid #fbbf24', borderRadius: '14px', padding: '14px 18px' }}>
        <p style={{ fontSize: '15px', fontStyle: 'italic', color: '#92400e', lineHeight: 1.6 }}>
          &ldquo;I was SO nervous. The second I met Dr. Samadian I knew I was in the right place. He showed me my new smile on a screen and I started crying happy tears. That was 2 years ago — best decision of my life.&rdquo;
        </p>
        <p style={{ fontSize: '13px', color: '#b45309', marginTop: '6px', fontWeight: 600 }}>— Linda K., 65</p>
      </div>
    </div>
  )
}

// ── Step 11: Contact ──────────────────────────────

function Q11({ d, u }: { d: FormData; u: (f: keyof FormData, v: string) => void }) {
  const inputStyle = { width: '100%', padding: '15px 18px', fontSize: '17px', border: '3px solid #e5e0d8', borderRadius: '14px', outline: 'none', background: '#fff', color: '#1f1a15', boxSizing: 'border-box' as const }
  return (
    <div>
      <H>Last step — where should we call you?</H>
      <P>A real person will call to schedule your <strong>FREE visit</strong> with Dr. Samadian. No robots.</P>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>First Name *</label>
            <input value={d.first_name} onChange={(e) => u('first_name',e.target.value)} placeholder="First name" style={inputStyle} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>Last Name</label>
            <input value={d.last_name} onChange={(e) => u('last_name',e.target.value)} placeholder="Last name" style={inputStyle} />
          </div>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>Phone Number *</label>
          <input value={d.phone} onChange={(e) => u('phone',e.target.value)} type="tel" placeholder="(555) 123-4567"
            style={{ ...inputStyle, border: '3px solid #d97706', background: '#fffbeb', fontSize: '20px', fontWeight: 600 }} />
          <p style={{ fontSize: '13px', color: '#78716c', marginTop: '6px' }}>We&apos;ll call or text to schedule your FREE consultation</p>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>Email *</label>
          <input value={d.email} onChange={(e) => u('email',e.target.value)} type="email" placeholder="your@email.com" required style={{ ...inputStyle, border: d.email && d.email.includes('@') ? '3px solid #16a34a' : inputStyle.border }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>City</label>
            <input value={d.city} onChange={(e) => u('city',e.target.value)} placeholder="Your city" style={inputStyle} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '14px', fontWeight: 700, color: '#1f1a15', marginBottom: '6px' }}>State</label>
            <input value={d.state} onChange={(e) => u('state',e.target.value)} placeholder="CA" maxLength={2} style={inputStyle} />
          </div>
        </div>
      </div>
      <div style={{ marginTop: '18px', background: '#f0fdf4', border: '2px solid #bbf7d0', borderRadius: '14px', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '22px' }}>🔒</span>
        <p style={{ fontSize: '13px', color: '#166534' }}><strong>100% private.</strong> We NEVER sell your info. That&apos;s a promise.</p>
      </div>
    </div>
  )
}

// ── Success ───────────────────────────────────────

function Done({ score, d }: { score: ScoreResult; d: FormData }) {
  return (
    <div style={{ textAlign: 'center' as const }}>
      <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: '#f0fdf4', border: '3px solid #bbf7d0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: '20px' }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/></svg>
      </div>
      <h2 style={{ fontSize: '26px', fontWeight: 800, color: '#1f1a15', marginBottom: '8px' }}>You did it, {d.first_name}! 🎉</h2>
      {score && (
        <div style={{ background: 'linear-gradient(135deg,#fef3c7,#fffbeb)', border: '3px solid #f59e0b', borderRadius: '18px', padding: '22px', margin: '16px 0', display: 'inline-block' }}>
          <p style={{ fontSize: '15px', fontWeight: 700, color: '#92400e', marginBottom: '6px' }}>
            {score.qualification==='hot' ? 'EXCELLENT — you look like a GREAT candidate!' : score.qualification==='warm' ? 'Looking good! You could be a strong candidate.' : 'Thanks for completing the assessment!'}
          </p>
          <div style={{ fontSize: '48px', fontWeight: 800, color: '#d97706' }}>{score.total}<span style={{ fontSize: '22px', color: '#b45309' }}>/100</span></div>
        </div>
      )}
      <p style={{ fontSize: '16px', color: '#57534e', lineHeight: 1.6, margin: '16px 0' }}>
        A real person will <strong>call or text you at {d.phone}</strong> within 24 hours to schedule your FREE consultation with Dr. Samadian.
      </p>
      <div style={{ background: '#fff', border: '3px solid #e5e0d8', borderRadius: '18px', padding: '22px', textAlign: 'left' as const }}>
        <p style={{ fontSize: '12px', fontWeight: 700, color: '#78716c', textTransform: 'uppercase' as const, letterSpacing: '1px', marginBottom: '14px' }}>WHAT HAPPENS NEXT</p>
        {['We call you to pick a time','FREE consult + 3D CT scan with Dr. Samadian','See your new smile designed on screen','If you love it — new teeth that same week'].map((t,i) => (
          <div key={i} style={{ display: 'flex', gap: '12px', marginBottom: '10px', alignItems: 'flex-start' }}>
            <span style={{ width: '26px', height: '26px', borderRadius: '50%', background: '#d97706', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 700, flexShrink: 0 }}>{i+1}</span>
            <span style={{ fontSize: '15px', color: '#44403c' }}>{t}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Progress ──────────────────────────────────────

function Bar({ c, t }: { c: number; t: number }) {
  const p = Math.round((c/t)*100)
  return (
    <div style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 600, color: '#78716c', marginBottom: '6px' }}><span>{c} of {t}</span><span>{p}%</span></div>
      <div style={{ height: '10px', borderRadius: '99px', background: '#e5e0d8', overflow: 'hidden' }}>
        <div style={{ height: '100%', borderRadius: '99px', background: 'linear-gradient(90deg,#d97706,#f59e0b)', width: `${p}%`, transition: 'width .5s ease' }} />
      </div>
    </div>
  )
}

// ── Main Export ────────────────────────────────────

export function QualificationFormSamadian({ orgId, orgName, apiBase = '', utmParams = {} }: { orgId: string; orgName?: string; apiBase?: string; utmParams?: Record<string, string> }) {
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [score, setScore] = useState<ScoreResult>(null)
  const [d, setD] = useState<FormData>({
    teeth_situation:'', teeth_count_upper:'', teeth_count_lower:'',
    previous_consults:'', previous_consult_locations:'', what_held_back:[] as string[],
    urgency:'', pain_level:[] as string[], credit_score_range:'', monthly_payment_range:'', has_cosigner:'',
    first_name:'', last_name:'', phone:'', email:'', city:'', state:'',
  })
  const u = useCallback((f: keyof FormData, v: string) => setD((p) => ({...p,[f]:v})), [])
  const toggle = useCallback((f: 'pain_level' | 'what_held_back', v: string) => {
    setD((p) => {
      const arr = p[f] as string[]
      return { ...p, [f]: arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v] }
    })
  }, [])
  const cfg = STEPS[step-1]
  const ok = cfg?.ok(d) ?? false

  async function submit() {
    setBusy(true)
    try {
      const map: Record<string,string> = { none:'missing_all_both', failing:'failing_teeth', dentures:'denture_problems', missing:'missing_multiple', smile:'other' }
      const payload = {
        first_name: d.first_name, last_name: d.last_name||undefined, phone: d.phone, email: d.email||undefined,
        city: d.city||undefined, state: d.state||undefined,
        dental_condition: map[d.teeth_situation]||'other',
        dental_condition_details: [`Teeth:${d.teeth_situation}`,`Upper:${d.teeth_count_upper}`,`Lower:${d.teeth_count_lower}`,
          d.previous_consults!=='no'?`Prev:${d.previous_consult_locations||d.previous_consults}`:'',d.what_held_back.length?`Block:${d.what_held_back.join(',')}`:'',
          `Pain:${d.pain_level.join(',')}`,`Credit:${d.credit_score_range}`,`Mo:${d.monthly_payment_range}`,`Cosign:${d.has_cosigner}`].filter(Boolean).join('|'),
        has_dentures: d.teeth_situation==='dentures', urgency: d.urgency,
        financing_interest: d.has_cosigner==='cash'?'cash_pay':'financing_needed', has_dental_insurance: false,
        budget_range: d.monthly_payment_range==='500'?'over_30k':d.monthly_payment_range==='350'?'20k_25k':d.monthly_payment_range==='200'?'15k_20k':'10k_15k',
        source_type: utmParams.source_type||'landing_page', utm_source: utmParams.utm_source||undefined, utm_medium: utmParams.utm_medium||undefined,
        utm_campaign: utmParams.utm_campaign||undefined, gclid: utmParams.gclid||undefined, fbclid: utmParams.fbclid||undefined,
        landing_page_url: typeof window!=='undefined'?window.location.href:undefined,
      }
      const r = await fetch(`${apiBase}/api/webhooks/qualify?org=${orgId}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
      if(!r.ok) throw new Error('fail')
      const res = await r.json(); setScore(res.score); setDone(true)
      if(typeof window!=='undefined'){(window as any).gtag?.('event','conversion',{send_to:'lead_qualification_complete'});(window as any).fbq?.('track','Lead')}
    } catch { alert('Something went wrong. Please call us directly.') }
    finally { setBusy(false) }
  }

  if(done) return <div style={{ maxWidth:'520px', margin:'0 auto', padding:'20px' }}><Done score={score} d={d}/></div>

  return (
    <div style={{ maxWidth:'520px', margin:'0 auto', padding:'12px 16px' }}>
      <Bar c={step} t={STEPS.length} />
      <div style={{ minHeight:'400px' }}>
        {step===1&&<Q1 d={d} u={u}/>}
        {step===2&&<H2/>}
        {step===3&&<Q3 d={d} u={u} toggle={toggle}/>}
        {step===4&&<H4/>}
        {step===5&&<Q5 d={d} toggle={toggle}/>}
        {step===6&&<H6/>}
        {step===7&&<Q7 d={d} u={u}/>}
        {step===8&&<H8/>}
        {step===9&&<Q9 d={d} u={u}/>}
        {step===10&&<H10/>}
        {step===11&&<Q11 d={d} u={u}/>}
      </div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:'28px', paddingBottom:'16px' }}>
        {step>1 ? <button type="button" onClick={() => setStep(s=>s-1)} style={{ fontSize:'15px', fontWeight:600, color:'#78716c', background:'none', border:'none', cursor:'pointer' }}>← Back</button> : <div/>}
        <button type="button" onClick={() => step===STEPS.length?submit():setStep(s=>s+1)} disabled={!ok||busy} style={{
          padding:'16px 32px', fontSize:'17px', fontWeight:800, borderRadius:'14px', border:'none',
          cursor: ok&&!busy?'pointer':'not-allowed',
          background: ok&&!busy?'linear-gradient(135deg,#d97706,#b45309)':'#e5e0d8',
          color: ok&&!busy?'#fff':'#a8a29e',
          boxShadow: ok&&!busy?'0 4px 14px rgba(217,119,6,.3)':'none',
          transition:'all .15s', width: step>1?'auto':'100%', minWidth:'200px',
        }}>
          {busy?'Checking...':step===STEPS.length?'SEE MY RESULTS →':cfg?.type==='h'?'KEEP GOING →':'NEXT →'}
        </button>
      </div>
    </div>
  )
}
