/**
 * Pre-op instruction template.
 *
 * One sensible default for implant surgery; per-org customization can layer on
 * later (a `preop_templates` table) without changing the send/portal flow —
 * the rendered HTML + structured content are snapshotted onto the preop_forms
 * row, so old forms keep displaying exactly what the patient saw.
 */

export type PreopContent = {
  sections: Array<{ title: string; items: string[] }>
}

export function defaultPreopContent(params: {
  patientName: string
  surgeryDate?: string | null
  surgeryTime?: string | null
  surgeryType?: string | null
  practiceName?: string | null
  practicePhone?: string | null
}): PreopContent {
  const when = params.surgeryDate
    ? new Date(`${params.surgeryDate}T${params.surgeryTime || '09:00'}`).toLocaleString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : 'your scheduled surgery time'

  return {
    sections: [
      {
        title: 'Before Your Surgery',
        items: [
          `Your ${params.surgeryType || 'implant surgery'} is scheduled for ${when}.`,
          'Do not eat or drink anything (including water) for 8 hours before surgery if you are receiving IV sedation or general anesthesia.',
          'If you take daily medications, ask us whether to take them with a small sip of water the morning of surgery.',
          'Do not smoke or drink alcohol for at least 24 hours before surgery.',
          'Get a full night\'s sleep and eat a nourishing meal the evening before.',
        ],
      },
      {
        title: 'The Day of Surgery',
        items: [
          'Arrange for a responsible adult to drive you home — you will not be able to drive after sedation.',
          'Wear loose, comfortable clothing with short sleeves.',
          'Do not wear contact lenses, jewelry, dark nail polish, or heavy makeup.',
          'Arrive 15 minutes early to complete any remaining paperwork.',
        ],
      },
      {
        title: 'After Your Surgery',
        items: [
          'Bite gently on the gauze pack for 30–60 minutes to control bleeding.',
          'Apply an ice pack to your cheek in 15-minute intervals for the first 24 hours.',
          'Eat only soft, cool foods for the first 24 hours; avoid straws, spitting, and rinsing.',
          'Take prescribed medications exactly as directed.',
          'Do not smoke for at least 72 hours — smoking significantly impairs implant healing.',
        ],
      },
      {
        title: 'When to Call Us',
        items: [
          'Bleeding that does not slow after 4 hours of gauze pressure.',
          'Severe pain not controlled by your prescribed medication.',
          'Fever over 101°F (38.3°C), or swelling that worsens after day 3.',
          params.practicePhone
            ? `Call ${params.practiceName || 'our office'} any time at ${params.practicePhone}.`
            : `Call ${params.practiceName || 'our office'} any time — the number is on your appointment card.`,
        ],
      },
    ],
  }
}

export function renderPreopHtml(params: {
  patientName: string
  content: PreopContent
  practiceName?: string | null
}): string {
  const sections = params.content.sections
    .map(
      (s) => `
      <section style="margin-bottom:24px;">
        <h2 style="font-size:16px;color:#1a1a1a;margin:0 0 8px;">${escapeHtml(s.title)}</h2>
        <ul style="margin:0;padding-left:20px;color:#444;font-size:14px;line-height:1.7;">
          ${s.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}
        </ul>
      </section>`
    )
    .join('')

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;">
      <p style="color:#444;font-size:14px;">Dear ${escapeHtml(params.patientName)},</p>
      <p style="color:#444;font-size:14px;">
        Please read these pre- and post-operative instructions carefully. Following them closely
        is the most important thing you can do for a smooth surgery and fast recovery.
      </p>
      ${sections}
      <p style="color:#999;font-size:12px;">${escapeHtml(params.practiceName || '')}</p>
    </div>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
