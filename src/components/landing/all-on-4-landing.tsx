'use client'

import { useState, useEffect, useRef } from 'react'
import { QualificationFormSamadian } from '@/components/forms/qualification-form-samadian'

// Dr. Samadian's org ID for form submission
const ORG_ID = 'fa64e53c-3d9b-493e-b904-59580cb3f29c'

// ── YouTube Testimonials ──────────────────────────────────────
const TESTIMONIALS = [
  {
    id: 'A1rkRepZoq4',
    name: 'Tyrone',
    headline: 'Same-Day All-on-X Implants',
    quote: 'I got a full mouth of implants and walked out smiling the same day. Dr. Samadian changed my life.',
  },
  {
    id: 'lZN6eToKGvw',
    name: 'Michael',
    headline: 'Life Changed in One Day',
    quote: 'My life changed in a single day. I went in with broken teeth and came out with a smile I never thought I\'d have.',
  },
  {
    id: 'iVSWvnqR3xM',
    name: 'Mike',
    headline: 'Decades of Dentures — Finally Free',
    quote: 'I lived with dentures for decades. Now I socialize, I eat what I want, I smile in photos. I wish I\'d done this years ago.',
  },
  {
    id: '3CFyAGI2ooM',
    name: 'Michael',
    headline: 'Confidence Completely Restored',
    quote: 'My smile makeover completely changed my social life. I feel like a different person. Dr. Samadian gave me my confidence back.',
  },
  {
    id: '46IDy3j2Fi8',
    name: 'Francine',
    headline: 'Feels Decades Younger',
    quote: 'I feel more confident in social settings than I have in years. I feel decades younger. Dr. Samadian is incredible.',
  },
  {
    id: '7nhEdSueijs',
    name: 'Suzanne',
    headline: '9 Years Later — Still Perfect',
    quote: 'It\'s been 9 years since my smile transformation and I still love it every single day. Best decision of my life.',
  },
  {
    id: 'S-IfDb3I_3Q',
    name: 'Gerry',
    headline: 'Back on Stage Singing',
    quote: 'As a jazz singer, my smile is everything. Dr. Samadian gave me the confidence to get back on stage and perform.',
  },
  {
    id: 'iC85PSD4Kss',
    name: 'Charmaine',
    headline: 'Back to Comedy & Acting',
    quote: 'I\'m back to comedy and acting. I couldn\'t do that before — I was too embarrassed to be on camera.',
  },
  {
    id: '4NBhpaOHbbc',
    name: 'Richie',
    headline: 'A Brand New Confidence',
    quote: 'The confidence I\'ve gained is unreal. I look at myself in the mirror and I can\'t stop smiling.',
  },
]

// ── Main Landing Page Component ───────────────────────────────

export function LandingPageContent({ utmParams = {} }: { utmParams?: Record<string, string> }) {
  const formRef = useRef<HTMLDivElement>(null)
  const [activeVideo, setActiveVideo] = useState(0)
  const [videoPlaying, setVideoPlaying] = useState(false)

  function scrollToForm() {
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="page-wrap" style={{ minHeight: '100vh', background: '#faf8f5', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>

      {/* ── Sticky Mobile CTA — media-query scoped ── */}
      <style>{`
        .sticky-cta-bar { display: none; }
        @media (max-width: 768px) {
          .sticky-cta-bar { display: flex; }
          .page-wrap { padding-bottom: 76px; }
        }
      `}</style>

      {/* ── Urgency Banner ── */}
      <div style={{ background: '#dc2626', color: '#fff', textAlign: 'center', padding: '12px 16px', fontSize: '14px', fontWeight: 700, letterSpacing: '.5px', position: 'sticky', top: 0, zIndex: 100 }}>
        ⚡ ONLY 7 FREE CONSULTATION SPOTS LEFT THIS MONTH — <button type="button" onClick={scrollToForm} style={{ background: 'none', border: 'none', color: '#fef08a', fontWeight: 800, cursor: 'pointer', textDecoration: 'underline', fontSize: '14px' }}>CLAIM YOURS NOW</button>
      </div>

      {/* ── Hero Section ── */}
      <section style={{ background: 'linear-gradient(180deg, #1c1917 0%, #292524 100%)', color: '#fff', padding: '0' }}>
        <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '48px 24px 0' }}>
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <p style={{ fontSize: '12px', fontWeight: 800, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px' }}>
              DR. AMIN SAMADIAN &bull; 1,500+ FULL ARCH CASES &bull; SAN FRANCISCO &amp; ORINDA
            </p>
            <h1 style={{ fontSize: 'clamp(32px, 5vw, 54px)', fontWeight: 900, lineHeight: 1.1, marginBottom: '20px', maxWidth: '800px', margin: '0 auto 20px' }}>
              Walk In With <span style={{ color: '#fbbf24' }}>No Teeth</span>.<br />Walk Out The <span style={{ color: '#fbbf24' }}>Same Day</span> Smiling.
            </h1>
            <p style={{ fontSize: '20px', color: '#a8a29e', lineHeight: 1.6, maxWidth: '640px', margin: '0 auto 32px' }}>
              Not a denture. Not a temporary. Your new permanent teeth — 3D-printed in our in-house lab, placed by one of the most experienced implant doctors in the Bay Area.
            </p>
            <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '40px' }}>
              <button type="button" onClick={scrollToForm} style={{
                padding: '18px 40px', fontSize: '18px', fontWeight: 800, borderRadius: '14px', border: 'none',
                background: 'linear-gradient(135deg, #d97706, #b45309)', color: '#fff', cursor: 'pointer',
                boxShadow: '0 4px 20px rgba(217,119,6,.4)', transition: 'transform .15s',
              }}>
                SEE IF I QUALIFY — FREE →
              </button>
              <a href="tel:+14158861942" style={{
                padding: '18px 32px', fontSize: '18px', fontWeight: 700, borderRadius: '14px',
                border: '2px solid #57534e', color: '#d6d3d1', textDecoration: 'none',
                display: 'inline-flex', alignItems: 'center', gap: '8px',
              }}>
                📞 Call Us Now
              </a>
            </div>
          </div>

          {/* Trust Stats Bar */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1px', background: '#44403c', borderRadius: '18px 18px 0 0', overflow: 'hidden' }}>
            {[
              { stat: '1,500+', label: 'Implant Cases' },
              { stat: 'Same Day', label: 'New Teeth' },
              { stat: 'In-House', label: 'Digital Lab' },
              { stat: '85%+', label: 'Financing Approved' },
            ].map((item, i) => (
              <div key={i} style={{ background: '#292524', padding: '20px 16px', textAlign: 'center' }}>
                <div style={{ fontSize: '28px', fontWeight: 800, color: '#fbbf24' }}>{item.stat}</div>
                <div style={{ fontSize: '13px', color: '#a8a29e', marginTop: '2px' }}>{item.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Problem Agitation Section ── */}
      <section style={{ padding: '64px 24px', background: '#fff' }}>
        <div style={{ maxWidth: '800px', margin: '0 auto', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', fontWeight: 800, color: '#dc2626', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px' }}>SOUND FAMILIAR?</p>
          <h2 style={{ fontSize: 'clamp(26px, 4vw, 40px)', fontWeight: 800, color: '#1c1917', lineHeight: 1.2, marginBottom: '40px' }}>
            Are You Tired of Living Like This?
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', textAlign: 'left' }}>
            {[
              { icon: '😔', text: 'Hiding your smile in every photo' },
              { icon: '🍎', text: 'Avoiding foods you love because you can\'t chew' },
              { icon: '😰', text: 'Dentures that slip, click, and embarrass you' },
              { icon: '💔', text: 'Avoiding social events and dating' },
              { icon: '😣', text: 'Constant pain and sensitivity' },
              { icon: '🏥', text: 'Told you "don\'t have enough bone" for implants' },
            ].map((item, i) => (
              <div key={i} style={{ background: '#fef2f2', border: '2px solid #fecaca', borderRadius: '14px', padding: '18px', display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                <span style={{ fontSize: '24px', flexShrink: 0 }}>{item.icon}</span>
                <p style={{ fontSize: '16px', color: '#7f1d1d', fontWeight: 600, lineHeight: 1.4, margin: 0 }}>{item.text}</p>
              </div>
            ))}
          </div>
          <div style={{ marginTop: '40px', background: 'linear-gradient(135deg,#fef3c7,#fffbeb)', border: '3px solid #f59e0b', borderRadius: '18px', padding: '28px' }}>
            <p style={{ fontSize: '22px', fontWeight: 800, color: '#92400e', lineHeight: 1.4, margin: 0 }}>
              What if you could fix ALL of that — in a single day?<br />
              <span style={{ color: '#d97706' }}>With Dr. Samadian, you can.</span>
            </p>
          </div>
        </div>
      </section>

      {/* ── Dr. Samadian Credentials ── */}
      <section style={{ padding: '64px 24px', background: '#1c1917', color: '#fff' }}>
        <div style={{ maxWidth: '900px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <p style={{ fontSize: '12px', fontWeight: 800, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px' }}>YOUR DOCTOR</p>
            <h2 style={{ fontSize: 'clamp(28px, 4vw, 42px)', fontWeight: 800, lineHeight: 1.2, marginBottom: '16px' }}>
              Dr. Amin Samadian, DDS
            </h2>
            <p style={{ fontSize: '18px', color: '#a8a29e', lineHeight: 1.6, maxWidth: '600px', margin: '0 auto' }}>
              One of the Bay Area&apos;s most experienced implant surgeons. Not a corporate chain. Not a dentist who &ldquo;also does implants.&rdquo; This is ALL he does.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px', marginBottom: '40px' }}>
            {[
              { icon: '🎓', title: 'Double Doctorate (DDS + DMD)', desc: 'University of the Pacific, Arthur A. Dugoni School of Dentistry + Tehran Azad University' },
              { icon: '📊', title: 'MBA from UC Berkeley Haas', desc: 'Combines clinical mastery with business & technology innovation' },
              { icon: '🏆', title: 'Two Fellowships in Implant Dentistry', desc: 'Specialized advanced training beyond what most dentists ever pursue' },
              { icon: '🎯', title: '1,500+ Full Arch Cases Completed', desc: 'Including "impossible" cases other doctors turned away' },
              { icon: '🏫', title: 'University Faculty', desc: 'Teaches at University of the Pacific, Dept. of Integrated Reconstructive Sciences' },
              { icon: '💤', title: 'Diplomate, Academy of Sleep Medicine', desc: 'Board-certified in TMJ & sleep apnea treatment' },
            ].map((item, i) => (
              <div key={i} style={{ background: '#292524', borderRadius: '16px', padding: '24px', border: '1px solid #44403c' }}>
                <span style={{ fontSize: '28px', display: 'block', marginBottom: '12px' }}>{item.icon}</span>
                <h3 style={{ fontSize: '17px', fontWeight: 700, marginBottom: '8px', color: '#fbbf24' }}>{item.title}</h3>
                <p style={{ fontSize: '14px', color: '#a8a29e', lineHeight: 1.5, margin: 0 }}>{item.desc}</p>
              </div>
            ))}
          </div>

          <div style={{ textAlign: 'center' }}>
            <div style={{ display: 'inline-flex', gap: '24px', flexWrap: 'wrap', justifyContent: 'center' }}>
              {['San Francisco', 'Orinda', 'Palo Alto', 'Beverly Hills'].map((loc) => (
                <span key={loc} style={{ fontSize: '14px', color: '#78716c', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ color: '#fbbf24' }}>📍</span> {loc}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── We're NOT ClearChoice Differentiation ── */}
      <section style={{ padding: '64px 24px', background: '#fff' }}>
        <div style={{ maxWidth: '800px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <p style={{ fontSize: '12px', fontWeight: 800, color: '#dc2626', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px' }}>REAL TALK</p>
            <h2 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 800, color: '#1c1917', lineHeight: 1.2, marginBottom: '16px' }}>
              We&apos;re NOT ClearChoice.<br />And We Fix the Cases They <span style={{ color: '#dc2626' }}>Turn Away</span>.
            </h2>
            <p style={{ fontSize: '18px', color: '#57534e', lineHeight: 1.6 }}>
              Big chains charge $40K+ and turn you down if you&apos;ve lost bone. Dr. Samadian SPECIALIZES in bone and gum regeneration. Cases other doctors call &ldquo;impossible&rdquo;? He does them every week.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
            <div style={{ background: '#fef2f2', borderRadius: '16px', padding: '24px', border: '2px solid #fecaca' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 800, color: '#dc2626', marginBottom: '16px' }}>❌ Corporate Chain</h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {['Cookie-cutter treatment plans', 'Outsourced lab — weeks of waiting', 'Rotating doctors you\'ve never met', '"Not enough bone" = goodbye', 'Pressure-cooker sales tactics', '$40K+ non-negotiable pricing'].map((item, i) => (
                  <li key={i} style={{ fontSize: '15px', color: '#991b1b', padding: '6px 0', display: 'flex', alignItems: 'flex-start', gap: '8px', lineHeight: 1.4 }}>
                    <span style={{ color: '#dc2626', flexShrink: 0 }}>✗</span> {item}
                  </li>
                ))}
              </ul>
            </div>
            <div style={{ background: '#f0fdf4', borderRadius: '16px', padding: '24px', border: '2px solid #bbf7d0' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 800, color: '#16a34a', marginBottom: '16px' }}>✅ Dr. Samadian</h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {['Custom treatment for YOUR mouth', 'In-house lab — same-day teeth', 'One doctor, start to finish', 'Bone regeneration specialist', 'No pressure, education-first', 'Flexible financing — 85% approved'].map((item, i) => (
                  <li key={i} style={{ fontSize: '15px', color: '#166534', padding: '6px 0', display: 'flex', alignItems: 'flex-start', gap: '8px', lineHeight: 1.4 }}>
                    <span style={{ color: '#16a34a', flexShrink: 0 }}>✓</span> {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── In-House Lab Section ── */}
      <section style={{ padding: '64px 24px', background: 'linear-gradient(180deg, #faf8f5, #fff)' }}>
        <div style={{ maxWidth: '900px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <p style={{ fontSize: '12px', fontWeight: 800, color: '#d97706', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px' }}>OUR SECRET WEAPON</p>
            <h2 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 800, color: '#1c1917', lineHeight: 1.2, marginBottom: '16px' }}>
              In-House Digital Lab.<br />Your Teeth Made <span style={{ color: '#d97706' }}>While You Wait</span>.
            </h2>
            <p style={{ fontSize: '18px', color: '#57534e', lineHeight: 1.6, maxWidth: '640px', margin: '0 auto' }}>
              Most dentists send your impressions to an outside lab and make you wait 2-3 weeks with a temporary. Not here. Your permanent teeth are designed and 3D-printed right in our office.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '40px' }}>
            {[
              { icon: '🔬', title: 'Digital 3D Scanning', desc: 'No goopy impressions. A quick scan captures your mouth in perfect 3D detail.' },
              { icon: '🖥️', title: 'AI-Powered Design', desc: 'Your new smile is designed digitally — you see it on screen BEFORE we make it.' },
              { icon: '🖨️', title: 'Same-Day 3D Printing', desc: 'Full porcelain teeth milled and printed in our lab in about an hour.' },
              { icon: '🦷', title: 'FP1 Cosmetic Grade', desc: 'Ultra-thin, Hollywood-grade prosthetics. Natural look — nobody knows they\'re implants.' },
            ].map((item, i) => (
              <div key={i} style={{ background: '#fff', borderRadius: '16px', padding: '24px', border: '2px solid #e5e0d8', textAlign: 'center' }}>
                <span style={{ fontSize: '36px', display: 'block', marginBottom: '14px' }}>{item.icon}</span>
                <h3 style={{ fontSize: '17px', fontWeight: 700, color: '#1c1917', marginBottom: '8px' }}>{item.title}</h3>
                <p style={{ fontSize: '14px', color: '#78716c', lineHeight: 1.5, margin: 0 }}>{item.desc}</p>
              </div>
            ))}
          </div>

          <div style={{ background: '#1c1917', borderRadius: '18px', padding: '32px', textAlign: 'center', color: '#fff' }}>
            <p style={{ fontSize: '16px', fontWeight: 700, color: '#fbbf24', marginBottom: '8px' }}>THE DIFFERENCE:</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '20px', alignItems: 'center', maxWidth: '500px', margin: '0 auto' }}>
              <div>
                <div style={{ fontSize: '28px', fontWeight: 800, color: '#ef4444' }}>2-3 wks</div>
                <div style={{ fontSize: '13px', color: '#a8a29e' }}>Outside Lab</div>
              </div>
              <div style={{ fontSize: '24px', color: '#57534e' }}>vs</div>
              <div>
                <div style={{ fontSize: '28px', fontWeight: 800, color: '#22c55e' }}>Same Day</div>
                <div style={{ fontSize: '13px', color: '#a8a29e' }}>Our In-House Lab</div>
              </div>
            </div>
            <p style={{ fontSize: '14px', color: '#78716c', marginTop: '16px' }}>No temporaries. No impressions. No second visit. One day.</p>
          </div>
        </div>
      </section>

      {/* ── Advanced Technology Section ── */}
      <section style={{ padding: '64px 24px', background: '#fff' }}>
        <div style={{ maxWidth: '800px', margin: '0 auto', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', fontWeight: 800, color: '#d97706', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px' }}>CUTTING-EDGE TECHNOLOGY</p>
          <h2 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 800, color: '#1c1917', lineHeight: 1.2, marginBottom: '40px' }}>
            Precision Other Offices Can&apos;t Match
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '16px' }}>
            {[
              { icon: '🤖', title: 'XGuide Navigational Surgery', desc: 'Robotic-guided implant placement — sub-millimeter accuracy. Tiny incisions, faster healing, less pain.' },
              { icon: '📐', title: '3D CT Scan + Digital Planning', desc: 'Your entire procedure is planned digitally before we touch a single tooth. No guesswork.' },
              { icon: '🧬', title: 'Bone & Gum Regeneration', desc: 'Lost bone? Dr. Samadian specializes in rebuilding what others say can\'t be fixed.' },
              { icon: '💆', title: 'IV Sedation — Sleep Through It', desc: 'You\'ll be completely comfortable. Most patients say it felt like a nap.' },
            ].map((item, i) => (
              <div key={i} style={{ textAlign: 'left', background: '#faf8f5', borderRadius: '16px', padding: '24px', border: '2px solid #e5e0d8' }}>
                <span style={{ fontSize: '32px', display: 'block', marginBottom: '12px' }}>{item.icon}</span>
                <h3 style={{ fontSize: '17px', fontWeight: 700, color: '#1c1917', marginBottom: '8px' }}>{item.title}</h3>
                <p style={{ fontSize: '14px', color: '#78716c', lineHeight: 1.5, margin: 0 }}>{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Package Tiers Section ── */}
      <section style={{ padding: '64px 24px', background: '#fff' }}>
        <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <p style={{ fontSize: '12px', fontWeight: 800, color: '#d97706', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px' }}>YOUR OPTIONS</p>
            <h2 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 800, color: '#1c1917', lineHeight: 1.2, marginBottom: '12px' }}>
              Three Ways to Get Your New Smile.<br />All Include Dr. Samadian.
            </h2>
            <p style={{ fontSize: '16px', color: '#78716c', lineHeight: 1.5, maxWidth: '640px', margin: '0 auto' }}>
              Every package includes the FREE 3D scan, smile design, and financing pre-approval. You choose the finish.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px', alignItems: 'stretch' }}>
            {[
              {
                tier: 'ESSENTIAL',
                name: 'All-on-4 Classic',
                material: 'Acrylic Hybrid',
                monthly: '199',
                bestFor: 'Patients focused on function + budget',
                featured: false,
                includes: [
                  '4 titanium implants per arch',
                  'Acrylic hybrid bridge (natural look)',
                  'Same-day fixed teeth',
                  'IV sedation included',
                  '5-year warranty on implants',
                ],
              },
              {
                tier: 'PREMIUM',
                name: 'All-on-4 Zirconia',
                material: 'Full Zirconia Bridge',
                monthly: '279',
                bestFor: 'Premium aesthetics + lifetime durability',
                featured: true,
                includes: [
                  '4 titanium implants per arch',
                  'Monolithic zirconia bridge (strongest)',
                  'Superior aesthetics — indistinguishable from real teeth',
                  'Stain & chip resistant for life',
                  'Same-day fixed teeth + IV sedation',
                  '10-year warranty on implants',
                ],
              },
              {
                tier: 'SIGNATURE',
                name: 'All-on-6 / Zygomatic',
                material: 'Full Zirconia, 6+ Implants',
                monthly: '369',
                bestFor: 'Complex cases + severe bone loss',
                featured: false,
                includes: [
                  '6+ implants per arch (including zygomatic if needed)',
                  'Full zirconia bridge — premium finish',
                  'Bone regeneration included',
                  'For patients turned away elsewhere',
                  'IV sedation + priority scheduling',
                  '10-year warranty on implants',
                ],
              },
            ].map((pkg, i) => (
              <div key={i} style={{
                position: 'relative',
                background: pkg.featured ? 'linear-gradient(180deg, #fff, #fffbeb)' : '#fff',
                border: pkg.featured ? '2px solid #d97706' : '2px solid #e5e0d8',
                borderRadius: '16px',
                padding: '28px 24px',
                boxShadow: pkg.featured ? '0 12px 32px rgba(217,119,6,.18)' : '0 2px 8px rgba(0,0,0,.04)',
                transform: pkg.featured ? 'translateY(-8px)' : 'none',
                display: 'flex',
                flexDirection: 'column',
              }}>
                {pkg.featured && (
                  <div style={{
                    position: 'absolute', top: '-14px', right: '20px',
                    background: '#dc2626', color: '#fff',
                    fontSize: '11px', fontWeight: 800, letterSpacing: '1px',
                    padding: '6px 14px', borderRadius: '999px',
                    boxShadow: '0 4px 12px rgba(220,38,38,.35)',
                  }}>
                    ⭐ MOST CHOSEN
                  </div>
                )}
                <p style={{ fontSize: '12px', fontWeight: 800, color: '#d97706', textTransform: 'uppercase', letterSpacing: '2px', margin: '0 0 8px' }}>{pkg.tier}</p>
                <h3 style={{ fontSize: '22px', fontWeight: 800, color: '#1c1917', margin: '0 0 4px' }}>{pkg.name}</h3>
                <p style={{ fontSize: '13px', color: '#78716c', margin: '0 0 20px' }}>{pkg.material}</p>
                <div style={{ marginBottom: '8px' }}>
                  <span style={{ fontSize: '14px', fontWeight: 700, color: '#78716c' }}>From </span>
                  <span style={{ fontSize: '40px', fontWeight: 800, color: '#d97706', lineHeight: 1 }}>${pkg.monthly}</span>
                  <span style={{ fontSize: '16px', fontWeight: 700, color: '#78716c' }}>/mo*</span>
                </div>
                <p style={{ fontSize: '13px', color: '#a8a29e', margin: '0 0 20px', fontStyle: 'italic' }}>Best for: {pkg.bestFor}</p>
                <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 24px', flex: 1 }}>
                  {pkg.includes.map((inc, j) => (
                    <li key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '8px 0', fontSize: '14px', color: '#57534e', lineHeight: 1.4, borderBottom: j < pkg.includes.length - 1 ? '1px solid #f5f5f4' : 'none' }}>
                      <span style={{ color: '#16a34a', fontWeight: 800, flexShrink: 0 }}>✓</span>
                      <span>{inc}</span>
                    </li>
                  ))}
                </ul>
                <button type="button" onClick={scrollToForm} style={{
                  padding: '14px 20px', fontSize: '15px', fontWeight: 800, borderRadius: '12px', border: 'none',
                  background: pkg.featured ? 'linear-gradient(135deg, #d97706, #b45309)' : '#1c1917',
                  color: '#fff', cursor: 'pointer',
                  boxShadow: pkg.featured ? '0 6px 18px rgba(217,119,6,.35)' : '0 2px 8px rgba(0,0,0,.15)',
                  width: '100%',
                }}>
                  SEE IF I QUALIFY →
                </button>
              </div>
            ))}
          </div>

          <p style={{ fontSize: '12px', color: '#a8a29e', textAlign: 'center', marginTop: '24px', lineHeight: 1.5, maxWidth: '720px', margin: '24px auto 0' }}>
            *Monthly payments based on qualified credit through our 6+ partner lenders. Actual payment depends on loan term, down payment, and credit profile. Same-day treatment and final pricing confirmed during your free consultation.
          </p>
        </div>
      </section>

      {/* ── Offers / Guarantees Band ── */}
      <section style={{ padding: '64px 24px', background: 'linear-gradient(135deg, #1c1917, #292524)', color: '#fff' }}>
        <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <p style={{ fontSize: '12px', fontWeight: 800, color: '#22c55e', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px' }}>TWO EXCLUSIVE GUARANTEES</p>
            <h2 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 800, lineHeight: 1.2 }}>
              We Put Our Money<br />Where Our Mouth Is.
            </h2>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px' }}>
            {[
              {
                icon: '🔍',
                title: 'FREE Second Opinion',
                body: 'Already been quoted by ClearChoice, Aspen, or another corporate chain? Bring us your itemized treatment plan. Dr. Samadian will personally review it — free, no pressure, no commitment. Our patients regularly save $5,000–$10,000 on the exact same treatment.',
                cta: 'Claim my second opinion →',
              },
              {
                icon: '🛡️',
                title: 'Price Match Guarantee',
                body: 'Found a lower price on the exact same treatment plan — same materials, same number of implants, same doctor credentials? Show us the itemized quote in writing. We\'ll match it. Same-day smile, same lender options, same doctor. No compromises.',
                cta: 'Show us your quote →',
              },
            ].map((offer, i) => (
              <div key={i} style={{
                background: '#44403c',
                border: '1px solid #57534e',
                borderRadius: '16px',
                padding: '28px',
                display: 'flex',
                flexDirection: 'column',
              }}>
                <div style={{ fontSize: '48px', marginBottom: '16px', lineHeight: 1 }}>{offer.icon}</div>
                <h3 style={{ fontSize: '22px', fontWeight: 800, color: '#fff', margin: '0 0 12px' }}>{offer.title}</h3>
                <p style={{ fontSize: '15px', color: '#d6d3d1', lineHeight: 1.6, margin: '0 0 20px', flex: 1 }}>{offer.body}</p>
                <button type="button" onClick={scrollToForm} style={{
                  background: 'none', border: 'none', color: '#fbbf24',
                  fontSize: '15px', fontWeight: 800, cursor: 'pointer',
                  textAlign: 'left', padding: 0,
                }}>
                  {offer.cta}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Video Testimonials Section ── */}
      <section style={{ padding: '64px 24px', background: '#1c1917', color: '#fff' }}>
        <div style={{ maxWidth: '900px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <p style={{ fontSize: '12px', fontWeight: 800, color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px' }}>REAL PATIENTS. REAL RESULTS.</p>
            <h2 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 800, lineHeight: 1.2, marginBottom: '16px' }}>
              Don&apos;t Take Our Word For It.<br />Hear From People <span style={{ color: '#fbbf24' }}>Just Like You</span>.
            </h2>
          </div>

          {/* Featured Video Player */}
          <div style={{ borderRadius: '18px', overflow: 'hidden', background: '#000', marginBottom: '24px', position: 'relative', paddingBottom: '56.25%' }}>
            <iframe
              src={`https://www.youtube.com/embed/${TESTIMONIALS[activeVideo].id}?rel=0&modestbranding=1`}
              title={`${TESTIMONIALS[activeVideo].name}'s testimonial`}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' }}
            />
          </div>

          {/* Video Quote */}
          <div style={{ background: '#292524', borderRadius: '14px', padding: '20px 24px', marginBottom: '24px', border: '1px solid #44403c' }}>
            <p style={{ fontSize: '16px', fontStyle: 'italic', color: '#d6d3d1', lineHeight: 1.6, margin: 0 }}>
              &ldquo;{TESTIMONIALS[activeVideo].quote}&rdquo;
            </p>
            <p style={{ fontSize: '14px', color: '#fbbf24', marginTop: '8px', fontWeight: 600 }}>
              — {TESTIMONIALS[activeVideo].name}, {TESTIMONIALS[activeVideo].headline}
            </p>
          </div>

          {/* Thumbnail Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '10px' }}>
            {TESTIMONIALS.map((t, i) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveVideo(i)}
                style={{
                  background: 'none', border: i === activeVideo ? '3px solid #fbbf24' : '3px solid transparent',
                  borderRadius: '12px', overflow: 'hidden', cursor: 'pointer', padding: 0,
                  opacity: i === activeVideo ? 1 : 0.7, transition: 'all .2s',
                }}
              >
                <div style={{ position: 'relative' }}>
                  <img
                    src={`https://img.youtube.com/vi/${t.id}/mqdefault.jpg`}
                    alt={`${t.name}'s story`}
                    style={{ width: '100%', display: 'block', borderRadius: '9px' }}
                    loading="lazy"
                  />
                  <div style={{ position: 'absolute', bottom: '6px', left: '6px', right: '6px', background: 'rgba(0,0,0,.7)', borderRadius: '6px', padding: '4px 8px' }}>
                    <p style={{ fontSize: '11px', fontWeight: 700, color: '#fff', margin: 0, lineHeight: 1.2 }}>{t.name}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── Objection Handling Section ── */}
      <section style={{ padding: '64px 24px', background: '#fff' }}>
        <div style={{ maxWidth: '800px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <p style={{ fontSize: '12px', fontWeight: 800, color: '#d97706', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px' }}>WHATEVER STOPPED YOU BEFORE</p>
            <h2 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 800, color: '#1c1917', lineHeight: 1.2 }}>
              We&apos;ve Heard Every Concern. We&apos;ve Solved All of Them.
            </h2>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {[
              {
                objection: '"It\'s too expensive"',
                answer: 'We work with 6+ lenders. 85% of patients get approved. Payments as low as $199/month. 0% interest plans available. We WILL find a way to make it work.',
                icon: '💰',
                color: '#d97706',
              },
              {
                objection: '"I was told I don\'t have enough bone"',
                answer: 'Dr. Samadian is a bone regeneration specialist. He treats cases that other doctors have turned away — every single week. "Not enough bone" is NOT a deal-breaker here.',
                icon: '🦴',
                color: '#16a34a',
              },
              {
                objection: '"I\'m scared of the pain"',
                answer: 'You\'ll be under IV sedation the entire time — you won\'t feel a thing. Patients say it felt like a nap. XGuide robotic surgery means tiny incisions and faster healing.',
                icon: '😴',
                color: '#2563eb',
              },
              {
                objection: '"I couldn\'t get financed"',
                answer: 'We don\'t use just one lender. We run your application through 6+ options including co-signer plans. Different lenders, different criteria. Most patients find one that works.',
                icon: '💳',
                color: '#7c3aed',
              },
              {
                objection: '"I don\'t trust dentists after bad experiences"',
                answer: 'We hear that a lot. That\'s why your first visit is FREE with zero pressure. Meet Dr. Samadian, see the lab, look at real patient results. If it doesn\'t feel right, walk away. No hard feelings.',
                icon: '🤝',
                color: '#0d9488',
              },
            ].map((item, i) => (
              <div key={i} style={{ background: '#faf8f5', borderRadius: '16px', padding: '24px', border: '2px solid #e5e0d8' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
                  <span style={{ fontSize: '28px' }}>{item.icon}</span>
                  <h3 style={{ fontSize: '18px', fontWeight: 800, color: '#1c1917', margin: 0 }}>{item.objection}</h3>
                </div>
                <p style={{ fontSize: '16px', color: '#57534e', lineHeight: 1.6, margin: 0, paddingLeft: '44px' }}>{item.answer}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Process Section ── */}
      <section style={{ padding: '64px 24px', background: 'linear-gradient(180deg, #faf8f5, #fff)' }}>
        <div style={{ maxWidth: '800px', margin: '0 auto', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', fontWeight: 800, color: '#d97706', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px' }}>YOUR JOURNEY</p>
          <h2 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 800, color: '#1c1917', lineHeight: 1.2, marginBottom: '40px' }}>
            From Missing Teeth to New Smile.<br />Here&apos;s How It Works.
          </h2>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0', position: 'relative' }}>
            {/* Connector line */}
            <div style={{ position: 'absolute', left: '28px', top: '40px', bottom: '40px', width: '3px', background: 'linear-gradient(to bottom, #d97706, #f59e0b)', borderRadius: '2px' }} />

            {[
              { step: '1', title: 'Take the 2-Minute Quiz', desc: 'Answer a few quick questions to see if you\'re a candidate. Takes less time than making coffee.', time: 'Today' },
              { step: '2', title: 'FREE Consultation + 3D Scan', desc: 'Meet Dr. Samadian personally. Get a FREE 3D CT scan (worth $500+). See your new smile designed on screen.', time: 'This Week' },
              { step: '3', title: 'Get Your Custom Plan + Financing', desc: 'Exact pricing, no surprises. We\'ll get you pre-approved for financing before you leave.', time: 'Same Visit' },
              { step: '4', title: 'New Teeth — Same Day', desc: 'Walk in with missing or failing teeth. Walk out with a brand new, permanent smile. All in one visit.', time: 'Treatment Day' },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', gap: '20px', alignItems: 'flex-start', textAlign: 'left', padding: '12px 0', position: 'relative', zIndex: 1 }}>
                <div style={{
                  width: '56px', height: '56px', borderRadius: '50%', flexShrink: 0,
                  background: 'linear-gradient(135deg, #d97706, #b45309)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '22px', fontWeight: 800, boxShadow: '0 4px 12px rgba(217,119,6,.3)',
                  border: '4px solid #faf8f5',
                }}>
                  {item.step}
                </div>
                <div style={{ flex: 1, paddingTop: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' }}>
                    <h3 style={{ fontSize: '18px', fontWeight: 800, color: '#1c1917', margin: 0 }}>{item.title}</h3>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: '#d97706', background: '#fffbeb', border: '1px solid #fbbf24', borderRadius: '6px', padding: '2px 8px' }}>{item.time}</span>
                  </div>
                  <p style={{ fontSize: '15px', color: '#78716c', lineHeight: 1.5, margin: 0 }}>{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FREE Value Stack + CTA ── */}
      <section style={{ padding: '64px 24px', background: '#1c1917', color: '#fff' }}>
        <div style={{ maxWidth: '700px', margin: '0 auto', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', fontWeight: 800, color: '#22c55e', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '16px' }}>WHAT YOU GET — 100% FREE</p>
          <h2 style={{ fontSize: 'clamp(26px, 4vw, 38px)', fontWeight: 800, lineHeight: 1.2, marginBottom: '32px' }}>
            Over $1,200 in Value.<br /><span style={{ color: '#fbbf24' }}>Yours FREE.</span> No Catch.
          </h2>

          <div style={{ background: '#292524', borderRadius: '18px', padding: '32px', textAlign: 'left', marginBottom: '32px', border: '1px solid #44403c' }}>
            {[
              { item: 'FREE 3D CT Scan', value: '$500+', desc: 'Full digital scan of your jaw and bone structure' },
              { item: 'FREE Digital Smile Design', value: '$300+', desc: 'See your new teeth on screen BEFORE you commit' },
              { item: 'FREE Custom Treatment Plan', value: '$250+', desc: 'Exact pricing and timeline — no surprises' },
              { item: 'FREE Financing Pre-Approval', value: '$0', desc: 'Know your monthly payment before you leave' },
              { item: 'Meet Dr. Samadian Personally', value: 'Priceless', desc: '1,500+ cases. You\'re in the best hands.' },
            ].map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 0', borderBottom: i < 4 ? '1px solid #44403c' : 'none' }}>
                <span style={{ fontSize: '20px', flexShrink: 0 }}>✅</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '16px', fontWeight: 700, color: '#fff' }}>{item.item}</span>
                    <span style={{ fontSize: '14px', fontWeight: 700, color: '#fbbf24' }}>{item.value}</span>
                  </div>
                  <p style={{ fontSize: '13px', color: '#a8a29e', margin: '2px 0 0' }}>{item.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div style={{ background: '#dc2626', borderRadius: '14px', padding: '20px', marginBottom: '24px' }}>
            <p style={{ fontSize: '20px', fontWeight: 800, margin: 0 }}>TOTAL VALUE: Over $1,200 — Yours FREE</p>
            <p style={{ fontSize: '14px', color: '#fecaca', marginTop: '6px' }}>No commitment. Walk away if you want. Zero pressure.</p>
          </div>

          <button type="button" onClick={scrollToForm} style={{
            padding: '20px 48px', fontSize: '20px', fontWeight: 800, borderRadius: '14px', border: 'none',
            background: 'linear-gradient(135deg, #d97706, #b45309)', color: '#fff', cursor: 'pointer',
            boxShadow: '0 6px 24px rgba(217,119,6,.4)', transition: 'transform .15s',
            width: '100%', maxWidth: '420px',
          }}>
            SEE IF I QUALIFY — FREE →
          </button>
        </div>
      </section>

      {/* ── Qualification Form Section ── */}
      <section ref={formRef} style={{ padding: '64px 24px 40px', background: '#faf8f5', scrollMarginTop: '60px' }}>
        <div style={{ maxWidth: '600px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '24px' }}>
            <p style={{ fontSize: '12px', fontWeight: 800, color: '#d97706', textTransform: 'uppercase', letterSpacing: '2px', marginBottom: '12px' }}>STEP 1 OF 4</p>
            <h2 style={{ fontSize: 'clamp(26px, 4vw, 36px)', fontWeight: 800, color: '#1c1917', lineHeight: 1.2, marginBottom: '12px' }}>
              See If You&apos;re a Candidate
            </h2>
            <p style={{ fontSize: '16px', color: '#78716c', lineHeight: 1.5 }}>
              Takes 2 minutes. 100% free. No obligation. A real person (not a robot) will call you within 24 hours.
            </p>
          </div>

          {/* The actual qualification form */}
          <div style={{ background: '#fff', borderRadius: '20px', border: '2px solid #e5e0d8', padding: '24px 20px', boxShadow: '0 4px 24px rgba(0,0,0,.06)' }}>
            <QualificationFormSamadian orgId={ORG_ID} orgName="Dion Health" utmParams={utmParams} />
          </div>

          <div style={{ marginTop: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
            <span style={{ fontSize: '18px' }}>🔒</span>
            <p style={{ fontSize: '13px', color: '#a8a29e', margin: 0 }}>Your information is 100% private. We NEVER sell your data.</p>
          </div>
        </div>
      </section>

      {/* ── Final Social Proof ── */}
      <section style={{ padding: '48px 24px', background: '#fff' }}>
        <div style={{ maxWidth: '800px', margin: '0 auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '16px' }}>
            {[
              { quote: 'Three dentists said I couldn\'t get implants. Dr. Samadian said "I can fix that." He did. I have the most beautiful teeth of my life.', name: 'Patricia W., 68' },
              { quote: 'I was SO nervous. The second I met Dr. Samadian I knew I was in the right place. He showed me my new smile on a screen and I started crying happy tears.', name: 'Linda K., 65' },
              { quote: 'I thought there was no way I could afford this. They got me approved in 20 minutes. I wish I\'d stopped waiting years ago.', name: 'Robert M., 71' },
            ].map((t, i) => (
              <div key={i} style={{ background: '#faf8f5', borderRadius: '16px', padding: '24px', border: '2px solid #e5e0d8' }}>
                <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
                  {[1,2,3,4,5].map((s) => <span key={s} style={{ fontSize: '18px', color: '#fbbf24' }}>★</span>)}
                </div>
                <p style={{ fontSize: '15px', fontStyle: 'italic', color: '#57534e', lineHeight: 1.6, margin: '0 0 12px' }}>&ldquo;{t.quote}&rdquo;</p>
                <p style={{ fontSize: '14px', fontWeight: 700, color: '#d97706', margin: 0 }}>— {t.name}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer style={{ background: '#1c1917', color: '#a8a29e', padding: '40px 24px' }}>
        <div style={{ maxWidth: '800px', margin: '0 auto', textAlign: 'center' }}>
          <p style={{ fontSize: '16px', fontWeight: 700, color: '#fff', marginBottom: '8px' }}>Dr. Amin Samadian, DDS</p>
          <p style={{ fontSize: '14px', marginBottom: '4px' }}>Board-Certified Cosmetic &amp; Implant Dentist &bull; TMJ &amp; Sleep Specialist</p>
          <p style={{ fontSize: '14px', marginBottom: '20px' }}>University of the Pacific Faculty &bull; UC Berkeley MBA</p>
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '20px' }}>
            <span>📍 San Francisco — 450 Sutter St, Suite 1519</span>
            <span>📍 Orinda — 23 Orinda Way #301</span>
          </div>
          <button type="button" onClick={scrollToForm} style={{
            padding: '16px 36px', fontSize: '16px', fontWeight: 800, borderRadius: '12px', border: 'none',
            background: 'linear-gradient(135deg, #d97706, #b45309)', color: '#fff', cursor: 'pointer',
            marginBottom: '24px',
          }}>
            CLAIM YOUR FREE CONSULTATION →
          </button>
          <p style={{ fontSize: '12px', color: '#57534e' }}>
            &copy; {new Date().getFullYear()} Dion Health. All rights reserved. Your information is 100% private.
          </p>
        </div>
      </footer>

      {/* ── Sticky Mobile CTA Bar (visible <768px only) ── */}
      <div className="sticky-cta-bar" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
        background: '#1c1917', borderTop: '2px solid #d97706',
        padding: '10px 12px', gap: '8px',
        boxShadow: '0 -4px 16px rgba(0,0,0,.25)',
      }}>
        <a href="tel:+14158861942" style={{
          flex: 1, textAlign: 'center', textDecoration: 'none',
          padding: '14px 10px', fontSize: '15px', fontWeight: 800, borderRadius: '10px',
          border: '2px solid #57534e', color: '#fff', background: 'transparent',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
        }}>
          📞 Call Now
        </a>
        <button type="button" onClick={scrollToForm} style={{
          flex: 2, padding: '14px 10px', fontSize: '15px', fontWeight: 800, borderRadius: '10px', border: 'none',
          background: 'linear-gradient(135deg, #d97706, #b45309)', color: '#fff', cursor: 'pointer',
          boxShadow: '0 4px 14px rgba(217,119,6,.4)',
        }}>
          SEE IF I QUALIFY →
        </button>
      </div>
    </div>
  )
}
