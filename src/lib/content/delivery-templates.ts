/**
 * Cross-Channel Delivery Templates
 *
 * Formats practice content assets for delivery across different channels.
 * SMS gets compact, link-focused messages.
 * Email gets rich HTML with embedded images and branding.
 *
 * Each formatter returns channel-appropriate content ready to send.
 */

import type { ContentAsset } from '@/types/database'
import { appendEmailFooter } from '@/lib/messaging/email-footer'

// ═══════════════════════════════════════════════════════════════
// SMS FORMATTERS
// ═══════════════════════════════════════════════════════════════

/**
 * Format a content asset for SMS delivery.
 * SMS must be under 1600 chars (Twilio limit), ideally under 320 chars.
 */
export function formatAssetForSMS(
  asset: ContentAsset,
  leadName: string,
  orgName: string
): string {
  const name = leadName || 'there'

  switch (asset.type) {
    case 'practice_info': {
      const c = asset.content as {
        address?: string
        city?: string
        state?: string
        zip?: string
        phone?: string
        hours?: string
        map_url?: string
        parking_notes?: string
      }
      const addressLine = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ')
      const lines = [`📍 ${orgName}`]
      if (addressLine) lines.push(addressLine)
      if (c.phone) lines.push(`📞 ${c.phone}`)
      if (c.hours) lines.push(`🕐 ${c.hours}`)
      if (c.map_url) lines.push(`\nDirections: ${c.map_url}`)
      if (c.parking_notes) lines.push(`\nParking: ${c.parking_notes}`)
      return lines.join('\n')
    }

    case 'testimonial_video': {
      const c = asset.content as {
        patient_name?: string
        procedure?: string
        quote?: string
        video_url?: string
      }
      // Fallback: use media_urls[0] if video_url not in content JSON
      const videoUrl = c.video_url || asset.media_urls?.[0] || null
      // Fallback: extract patient name from asset title ("Name – Title" format)
      const patientName = c.patient_name || asset.title.split('–')[0]?.split('—')[0]?.trim() || null

      const lines = [`Hi ${name}! Here's a story from one of our patients:`]
      if (patientName && c.procedure) {
        lines.push(`${patientName} — ${c.procedure}`)
      } else if (patientName) {
        lines.push(patientName)
      }
      if (c.quote) {
        const truncatedQuote = c.quote.length > 120 ? c.quote.substring(0, 117) + '...' : c.quote
        lines.push(`"${truncatedQuote}"`)
      }
      if (videoUrl) {
        lines.push(`\nWatch their story: ${videoUrl}`)
      }
      return lines.join('\n')
    }

    case 'before_after_photo': {
      const c = asset.content as {
        patient_name?: string
        procedure?: string
        description?: string
        gallery_url?: string
        after_url?: string
      }
      const lines = [`Hi ${name}! Check out this smile transformation:`]
      if (c.patient_name) lines.push(`Patient: ${c.patient_name}`)
      if (c.procedure) lines.push(`Procedure: ${c.procedure}`)
      if (c.description) {
        const truncated = c.description.length > 100 ? c.description.substring(0, 97) + '...' : c.description
        lines.push(truncated)
      }
      // SMS can't embed images — send a link to the gallery or the image URL
      if (c.gallery_url) {
        lines.push(`\nSee the results: ${c.gallery_url}`)
      } else if (c.after_url) {
        lines.push(`\nView photo: ${c.after_url}`)
      }
      return lines.join('\n')
    }

    case 'financing_info': {
      const c = asset.content as {
        summary?: string
        options?: Array<{ name: string; description: string }>
        apply_url?: string
      }
      const lines = [`💰 Payment Options at ${orgName}:`]
      if (c.summary) lines.push(c.summary)
      if (c.options && c.options.length > 0) {
        c.options.slice(0, 3).forEach(opt => {
          lines.push(`• ${opt.name}: ${opt.description}`)
        })
      }
      if (c.apply_url) lines.push(`\nApply here: ${c.apply_url}`)
      return lines.join('\n')
    }

    case 'procedure_info': {
      const c = asset.content as {
        procedure_name?: string
        overview?: string
        duration?: string
        recovery?: string
        benefits?: string[]
      }
      const lines: string[] = []
      if (c.procedure_name) lines.push(`ℹ️ ${c.procedure_name}`)
      if (c.overview) {
        const truncated = c.overview.length > 200 ? c.overview.substring(0, 197) + '...' : c.overview
        lines.push(truncated)
      }
      if (c.duration) lines.push(`⏱ Duration: ${c.duration}`)
      if (c.recovery) lines.push(`🔄 Recovery: ${c.recovery}`)
      return lines.join('\n')
    }

    case 'appointment_details': {
      const c = asset.content as {
        template?: string
      }
      return c.template || `Hi ${name}, your appointment details from ${orgName} are confirmed! We look forward to seeing you.`
    }

    default:
      return asset.description || asset.title
  }
}

/**
 * Format a custom message for SMS delivery.
 */
export function formatCustomSMS(
  message: string,
  _leadName: string
): string {
  // Truncate if needed (Twilio supports up to 1600 chars, but shorter is better)
  if (message.length > 1500) {
    return message.substring(0, 1497) + '...'
  }
  return message
}

// ═══════════════════════════════════════════════════════════════
// EMAIL FORMATTERS
// ═══════════════════════════════════════════════════════════════

/**
 * Format a content asset for email delivery.
 * Returns subject, HTML body, and plaintext fallback.
 */
export function formatAssetForEmail(
  asset: ContentAsset,
  leadName: string,
  orgName: string,
  options?: { leadId?: string; orgId?: string }
): { subject: string; html: string; text: string } {
  const name = leadName || 'there'
  let subject: string
  let bodyHtml: string
  let bodyText: string

  switch (asset.type) {
    case 'practice_info': {
      const c = asset.content as {
        address?: string
        city?: string
        state?: string
        zip?: string
        phone?: string
        hours?: string
        map_url?: string
        parking_notes?: string
      }
      subject = `📍 How to find ${orgName}`
      const addressLine = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ')

      bodyHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; padding: 32px;">
          <h2 style="color: #1e293b; margin-bottom: 8px;">📍 ${orgName}</h2>
          ${addressLine ? `<p style="color: #475569; font-size: 16px; margin: 4px 0;"><strong>Address:</strong> ${addressLine}</p>` : ''}
          ${c.phone ? `<p style="color: #475569; font-size: 16px; margin: 4px 0;"><strong>Phone:</strong> ${c.phone}</p>` : ''}
          ${c.hours ? `<p style="color: #475569; font-size: 16px; margin: 4px 0;"><strong>Hours:</strong> ${c.hours}</p>` : ''}
          ${c.parking_notes ? `<p style="color: #475569; font-size: 14px; margin: 12px 0; padding: 12px; background: #f8fafc; border-radius: 8px;">🅿️ <strong>Parking:</strong> ${c.parking_notes}</p>` : ''}
          ${c.map_url ? `<p style="margin: 20px 0;"><a href="${c.map_url}" style="background: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">📍 Get Directions</a></p>` : ''}
          <p style="color: #94a3b8; font-size: 14px;">We look forward to seeing you, ${name}!</p>
        </div>
      `
      bodyText = `${orgName}\n${addressLine}\n${c.phone ? `Phone: ${c.phone}` : ''}\n${c.hours ? `Hours: ${c.hours}` : ''}\n${c.map_url ? `Directions: ${c.map_url}` : ''}`
      break
    }

    case 'testimonial_video': {
      const c = asset.content as {
        patient_name?: string
        procedure?: string
        quote?: string
        video_url?: string
        thumbnail_url?: string
      }
      // Fallback: use media_urls[0] if video_url not in content JSON
      const videoUrl = c.video_url || asset.media_urls?.[0] || null
      // Fallback: extract patient name from asset title ("Name – Title" format)
      const patientName = c.patient_name || asset.title.split('–')[0]?.split('—')[0]?.trim() || null
      // Auto-generate YouTube thumbnail if none provided
      const youtubeId = videoUrl?.match(/(?:v=|youtu\.be\/)([\w-]+)/)?.[1]
      const thumbnailUrl = c.thumbnail_url || (youtubeId ? `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg` : null)

      subject = `🌟 Patient Story: ${patientName ? `${patientName}'s` : 'A'} Smile Transformation`

      bodyHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; padding: 32px;">
          <h2 style="color: #1e293b; margin-bottom: 16px;">🌟 Real Patient, Real Results</h2>
          ${patientName ? `<p style="color: #475569; font-size: 18px; font-weight: 600; margin-bottom: 4px;">${patientName}</p>` : ''}
          ${c.procedure ? `<p style="color: #7c3aed; font-size: 14px; margin-bottom: 16px;">${c.procedure}</p>` : ''}
          ${c.quote ? `<blockquote style="border-left: 4px solid #7c3aed; padding: 12px 16px; margin: 16px 0; background: #faf5ff; border-radius: 0 8px 8px 0;"><p style="color: #475569; font-size: 16px; font-style: italic; margin: 0;">"${c.quote}"</p></blockquote>` : ''}
          ${thumbnailUrl ? `<a href="${videoUrl || '#'}" style="display: block; position: relative; margin: 16px 0;"><img src="${thumbnailUrl}" alt="Patient testimonial" style="width: 100%; max-width: 560px; border-radius: 12px;" /><div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 64px; height: 64px; background: rgba(124,58,237,0.9); border-radius: 50%; display: flex; align-items: center; justify-content: center;"><span style="color: white; font-size: 28px; margin-left: 4px;">▶</span></div></a>` : ''}
          ${videoUrl ? `<p style="margin: 20px 0;"><a href="${videoUrl}" style="background: #7c3aed; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; font-size: 16px;">▶️ Watch ${patientName ? `${patientName}'s` : 'Their'} Story</a></p>` : ''}
          <p style="color: #94a3b8; font-size: 14px;">Hi ${name}, we thought you might find this inspiring!</p>
        </div>
      `
      bodyText = `Real Patient Story${patientName ? ` — ${patientName}` : ''}\n${c.quote ? `"${c.quote}"` : ''}\n${videoUrl ? `Watch: ${videoUrl}` : ''}`
      break
    }

    case 'before_after_photo': {
      const c = asset.content as {
        patient_name?: string
        procedure?: string
        description?: string
        before_url?: string
        after_url?: string
        gallery_url?: string
      }
      subject = `✨ Smile Transformation${c.patient_name ? ` — ${c.patient_name}` : ''}: Before & After`

      bodyHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; padding: 32px;">
          <h2 style="color: #1e293b; margin-bottom: 16px;">✨ Before & After Transformation</h2>
          ${c.patient_name ? `<p style="color: #475569; font-size: 16px;"><strong>${c.patient_name}</strong>${c.procedure ? ` — ${c.procedure}` : ''}</p>` : ''}
          <div style="display: flex; gap: 12px; margin: 20px 0;">
            ${c.before_url ? `<div style="flex: 1; text-align: center;"><p style="font-size: 12px; color: #94a3b8; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">Before</p><img src="${c.before_url}" alt="Before" style="width: 100%; border-radius: 12px; border: 2px solid #e2e8f0;" /></div>` : ''}
            ${c.after_url ? `<div style="flex: 1; text-align: center;"><p style="font-size: 12px; color: #7c3aed; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px;">After</p><img src="${c.after_url}" alt="After" style="width: 100%; border-radius: 12px; border: 2px solid #7c3aed;" /></div>` : ''}
          </div>
          ${c.description ? `<p style="color: #475569; font-size: 15px; line-height: 1.6; margin: 16px 0;">${c.description}</p>` : ''}
          ${c.gallery_url ? `<p style="margin: 20px 0;"><a href="${c.gallery_url}" style="background: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block;">View More Transformations</a></p>` : ''}
          <p style="color: #94a3b8; font-size: 14px;">Hi ${name}, this could be your smile too! Ready to learn more?</p>
        </div>
      `
      bodyText = `Before & After${c.patient_name ? ` — ${c.patient_name}` : ''}\n${c.description || ''}\n${c.gallery_url ? `See more: ${c.gallery_url}` : ''}`
      break
    }

    case 'financing_info': {
      const c = asset.content as {
        summary?: string
        options?: Array<{ name: string; description: string }>
        apply_url?: string
      }
      subject = `💰 Payment Options at ${orgName}`

      const optionsHtml = (c.options || []).map(opt =>
        `<div style="padding: 12px 16px; background: #f8fafc; border-radius: 8px; margin: 8px 0;">
          <p style="font-weight: 600; color: #1e293b; margin: 0 0 4px;">${opt.name}</p>
          <p style="color: #475569; margin: 0; font-size: 14px;">${opt.description}</p>
        </div>`
      ).join('')

      bodyHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; padding: 32px;">
          <h2 style="color: #1e293b; margin-bottom: 16px;">💰 Flexible Payment Options</h2>
          ${c.summary ? `<p style="color: #475569; font-size: 16px; line-height: 1.6;">${c.summary}</p>` : ''}
          ${optionsHtml}
          ${c.apply_url ? `<p style="margin: 24px 0;"><a href="${c.apply_url}" style="background: #059669; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; display: inline-block; font-size: 16px;">Check Your Options (No Credit Impact)</a></p>` : ''}
          <p style="color: #94a3b8; font-size: 14px;">Hi ${name}, we have options to fit every budget. Don't hesitate to reach out with questions!</p>
        </div>
      `
      bodyText = `Payment Options at ${orgName}\n${c.summary || ''}\n${(c.options || []).map(o => `• ${o.name}: ${o.description}`).join('\n')}\n${c.apply_url ? `Apply: ${c.apply_url}` : ''}`
      break
    }

    case 'procedure_info': {
      const c = asset.content as {
        procedure_name?: string
        overview?: string
        duration?: string
        recovery?: string
        benefits?: string[]
      }
      subject = `ℹ️ ${c.procedure_name || 'Procedure'} — What to Know`

      const benefitsHtml = (c.benefits || []).map(b =>
        `<li style="color: #475569; padding: 4px 0;">${b}</li>`
      ).join('')

      bodyHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; padding: 32px;">
          <h2 style="color: #1e293b; margin-bottom: 16px;">ℹ️ ${c.procedure_name || 'Procedure Overview'}</h2>
          ${c.overview ? `<p style="color: #475569; font-size: 16px; line-height: 1.6; margin-bottom: 16px;">${c.overview}</p>` : ''}
          <div style="display: flex; gap: 16px; margin: 20px 0;">
            ${c.duration ? `<div style="flex: 1; padding: 16px; background: #f0fdf4; border-radius: 8px; text-align: center;"><p style="font-size: 12px; color: #059669; text-transform: uppercase; margin: 0;">Duration</p><p style="font-size: 18px; font-weight: 600; color: #1e293b; margin: 4px 0 0;">${c.duration}</p></div>` : ''}
            ${c.recovery ? `<div style="flex: 1; padding: 16px; background: #eff6ff; border-radius: 8px; text-align: center;"><p style="font-size: 12px; color: #3b82f6; text-transform: uppercase; margin: 0;">Recovery</p><p style="font-size: 18px; font-weight: 600; color: #1e293b; margin: 4px 0 0;">${c.recovery}</p></div>` : ''}
          </div>
          ${benefitsHtml ? `<h3 style="color: #1e293b; margin: 20px 0 8px;">Key Benefits</h3><ul style="padding-left: 20px;">${benefitsHtml}</ul>` : ''}
          <p style="color: #94a3b8; font-size: 14px; margin-top: 24px;">Hi ${name}, want to learn more? We'd love to answer your questions during a free consultation!</p>
        </div>
      `
      bodyText = `${c.procedure_name || 'Procedure Info'}\n${c.overview || ''}\n${c.duration ? `Duration: ${c.duration}` : ''}\n${c.recovery ? `Recovery: ${c.recovery}` : ''}\n${(c.benefits || []).map(b => `• ${b}`).join('\n')}`
      break
    }

    default:
      subject = asset.title
      bodyHtml = `<div style="font-family: -apple-system, sans-serif; padding: 24px;"><p>${asset.description || asset.title}</p></div>`
      bodyText = asset.description || asset.title
  }

  // Append CAN-SPAM footer if we have lead/org IDs
  if (options?.leadId && options?.orgId) {
    bodyHtml = appendEmailFooter(bodyHtml, {
      leadId: options.leadId,
      orgId: options.orgId,
      orgName,
    })
  }

  return { subject, html: bodyHtml, text: bodyText }
}

/**
 * Format a custom message for email delivery.
 */
export function formatCustomEmail(
  message: string,
  leadName: string,
  orgName: string,
  options?: { subject?: string; leadId?: string; orgId?: string }
): { subject: string; html: string; text: string } {
  const name = leadName || 'there'
  const subject = options?.subject || `Message from ${orgName}`

  let html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; padding: 32px;">
      <p style="color: #475569; font-size: 16px; line-height: 1.6;">Hi ${name},</p>
      <div style="color: #1e293b; font-size: 16px; line-height: 1.6; margin: 16px 0;">
        ${message.replace(/\n/g, '<br>')}
      </div>
      <p style="color: #94a3b8; font-size: 14px; margin-top: 24px;">— The team at ${orgName}</p>
    </div>
  `

  if (options?.leadId && options?.orgId) {
    html = appendEmailFooter(html, {
      leadId: options.leadId,
      orgId: options.orgId,
      orgName,
    })
  }

  return { subject, html, text: message }
}
