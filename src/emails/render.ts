/**
 * Render React Email templates to { html, text } pairs.
 *
 * Returns BOTH so we can:
 *   - send the HTML version via Resend
 *   - store the text version on `messages.body` for the audit trail and conversation history
 *     (Plain text avoids storing HTML in the timeline UI; the brief asks us to "store rendered
 *     HTML snapshots with each message row for audit" — we keep both via metadata.html_snapshot
 *     when needed.)
 */

import { render } from '@react-email/render'
import * as React from 'react'

export type RenderedEmail = {
  html: string
  text: string
}

export async function renderEmail(element: React.ReactElement): Promise<RenderedEmail> {
  const [html, text] = await Promise.all([
    render(element, { pretty: false }),
    render(element, { plainText: true }),
  ])
  return { html, text }
}
