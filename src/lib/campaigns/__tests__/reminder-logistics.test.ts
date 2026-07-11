import { describe, it, expect } from 'vitest'
import * as React from 'react'
import { renderEmail } from '@/emails/render'
import { BookingReminder } from '@/emails/BookingReminder'
import { generate72hEmailTemplate } from '@/lib/campaigns/reminder-templates'
import { renderVisitLogistics } from '@/lib/branding/visit-logistics'

const logistics = {
  addressText: '450 Sutter St, Ste 1519', drivingText: 'Between Powell and Stockton',
  parkingText: 'Sutter-Stockton Garage', transitText: 'Powell St BART', whatToExpectText: 'Arrive 10 min early.\nBring ID.',
}

describe('reminder logistics wiring', () => {
  it('72h HTML template embeds Getting here + What to expect', () => {
    const rl = renderVisitLogistics({ logistics })
    const t = generate72hEmailTemplate({ firstName: 'Sam', appointmentType: 'consultation', dateTime: 'Mon 3pm', location: null, practiceName: 'Dion Health', confirmUrl: 'https://x/c', rescheduleUrl: 'https://x/r', logisticsHtml: rl.emailHtml, logisticsText: rl.emailText })
    expect(t.html).toContain('Getting here')
    expect(t.html).toContain('450 Sutter St, Ste 1519')
    expect(t.html).toContain('By BART / transit:')
    expect(t.text).toContain('By car: Between Powell and Stockton')
    expect(t.text).toContain('What to expect:')
  })
  it('24h React email renders the logistics section', async () => {
    const { html } = await renderEmail(React.createElement(BookingReminder, {
      leadId: 'l', orgId: 'o', orgName: 'Dion Health', firstName: 'Sam', consultLabel: 'consultation',
      scheduledAt: new Date('2026-08-01T22:00:00Z').toISOString(), durationMinutes: 60, window: '24h', logistics,
    }))
    expect(html).toContain('Getting here')
    expect(html).toContain('450 Sutter St, Ste 1519')
    expect(html).toContain('What to expect')
  })
})
