import { describe, it, expect } from 'vitest'
import {
  generate72hEmailTemplate,
  generate24hEmailTemplate,
  generate24hSmsTemplate,
} from '@/lib/campaigns/reminder-templates'

const base = {
  firstName: 'Dana',
  appointmentType: 'consultation',
  dateTime: 'Wednesday, July 15 at 10:00 AM',
  location: '450 Sutter St',
  practiceName: 'SF Dentistry',
  confirmUrl: 'https://app.test/confirm?token=c',
  rescheduleUrl: 'https://app.test/reschedule?token=r',
}

describe('reminder templates — protected cohort suppresses reschedule', () => {
  it('72h email keeps confirm but drops reschedule button + URL when protected', () => {
    const normal = generate72hEmailTemplate(base)
    expect(normal.html).toContain(base.rescheduleUrl)
    expect(normal.text).toContain('Need to reschedule?')

    const prot = generate72hEmailTemplate({ ...base, protected: true })
    // Confirm path survives.
    expect(prot.html).toContain(base.confirmUrl)
    // Reschedule button, footer line, and text link all gone.
    expect(prot.html).not.toContain(base.rescheduleUrl)
    expect(prot.html).not.toContain('cancel or reschedule')
    expect(prot.text).not.toContain('Need to reschedule?')
  })

  it('24h email keeps confirm but drops the "I Need to Reschedule" CTA when protected', () => {
    const prot = generate24hEmailTemplate({ ...base, protected: true })
    expect(prot.html).toContain(base.confirmUrl)
    expect(prot.html).not.toContain(base.rescheduleUrl)
    expect(prot.html).not.toContain('I Need to Reschedule')
    expect(prot.text).not.toContain('Need to reschedule?')
  })

  it('24h SMS keeps the confirm ask but drops "call us to reschedule" when protected', () => {
    const normal = generate24hSmsTemplate(base)
    expect(normal).toContain('call us to reschedule')

    const prot = generate24hSmsTemplate({ ...base, protected: true })
    expect(prot).toContain('Reply YES to confirm')
    expect(prot).not.toContain('reschedule')
  })
})
