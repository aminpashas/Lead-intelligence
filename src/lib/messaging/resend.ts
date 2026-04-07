import { Resend } from 'resend'

function getResend() {
  return new Resend(process.env.RESEND_API_KEY!)
}

export async function sendEmail(params: {
  to: string
  subject: string
  html: string
  text?: string
  from?: string
  replyTo?: string
}): Promise<{ id: string }> {
  const { data, error } = await getResend().emails.send({
    from: params.from || process.env.RESEND_FROM_EMAIL!,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    replyTo: params.replyTo,
  })

  if (error) {
    throw new Error(`Failed to send email: ${error.message}`)
  }

  return { id: data!.id }
}

export async function sendBatchEmails(
  emails: Array<{
    to: string
    subject: string
    html: string
    text?: string
  }>
): Promise<{ ids: string[] }> {
  const { data, error } = await getResend().batch.send(
    emails.map((e) => ({
      from: process.env.RESEND_FROM_EMAIL!,
      to: e.to,
      subject: e.subject,
      html: e.html,
      text: e.text,
    }))
  )

  if (error) {
    throw new Error(`Failed to send batch emails: ${error.message}`)
  }

  return { ids: data!.data.map((d) => d.id) }
}
