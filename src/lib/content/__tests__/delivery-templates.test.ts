import { describe, it, expect } from 'vitest'
import { formatCustomEmail, hasOwnGreeting, hasOwnSignOff } from '@/lib/content/delivery-templates'

describe('formatCustomEmail wrapper dedup', () => {
  it('adds greeting + footer around a bare message', () => {
    const { html, subject } = formatCustomEmail('Your consult is confirmed for Tuesday.', 'Amin', 'SF Dentistry')
    expect(html).toContain('Hi Amin,')
    expect(html).toContain('— The team at SF Dentistry')
    expect(subject).toBe('Message from SF Dentistry')
  })

  it('does NOT add a second greeting when the AI body already opens with one', () => {
    const { html } = formatCustomEmail('Hi Amin,\n\nThanks for reaching out.', 'Amin', 'SF Dentistry')
    expect(html.match(/Hi Amin,/g)).toHaveLength(1)
  })

  it('does NOT add its footer when the body already carries a signature', () => {
    const body = 'Hi Amin,\n\nDetails inside.\n\nWarm regards,\nThe Dion Health Team'
    const { html } = formatCustomEmail(body, 'Amin', 'SF Dentistry')
    expect(html).not.toContain('— The team at SF Dentistry')
  })

  it('brandName overrides orgName in subject and footer', () => {
    const { html, subject } = formatCustomEmail('Just a note.', 'Amin', 'SF Dentistry', {
      brandName: 'Dion Health',
    })
    expect(subject).toBe('Message from Dion Health')
    expect(html).toContain('— The team at Dion Health')
    expect(html).not.toContain('SF Dentistry')
  })
})

describe('greeting / sign-off detectors', () => {
  it.each(['Hi Amin,', 'Hey there!', 'Hello,', 'Dear Amin,', 'Good morning Amin,'])(
    'detects greeting: %s',
    (g) => expect(hasOwnGreeting(`${g}\nbody`)).toBe(true)
  )
  it('does not false-positive on greeting-less bodies', () => {
    expect(hasOwnGreeting('Quick update on your financing application.')).toBe(false)
  })
  it.each([
    'Warm regards,\nThe Team',
    'Sincerely,\nDr. S',
    'Best,\nAmin',
    '— The Dion Health team',
    'the team at Dion Health',
  ])('detects sign-off: %s', (s) => expect(hasOwnSignOff(`body\n\n${s}`)).toBe(true))
  it('does not false-positive on plain bodies', () => {
    expect(hasOwnSignOff('We look forward to seeing you Tuesday.')).toBe(false)
  })
})
