import type { Lead } from '@/types/database'
import type { Branding } from '@/lib/branding/schema'
import { resolveBrandForContext } from '@/lib/branding/resolve-brand'

export type TemplateContext = {
  lead: Partial<Lead>
  practice_name: string
  org_id: string
  app_url: string
}

const VARIABLE_MAP: Record<string, (ctx: TemplateContext) => string> = {
  first_name: (ctx) => ctx.lead.first_name || 'there',
  last_name: (ctx) => ctx.lead.last_name || '',
  full_name: (ctx) => `${ctx.lead.first_name || ''} ${ctx.lead.last_name || ''}`.trim() || 'there',
  email: (ctx) => ctx.lead.email || '',
  phone: (ctx) => ctx.lead.phone || '',
  city: (ctx) => ctx.lead.city || '',
  state: (ctx) => ctx.lead.state || '',
  practice_name: (ctx) => ctx.practice_name,
  consultation_link: (ctx) => `${ctx.app_url}/qualify/${ctx.org_id}`,
  booking_link: (ctx) => `${ctx.app_url}/book/${ctx.org_id}`,
  score: (ctx) => String(ctx.lead.ai_score || 0),
  qualification: (ctx) => ctx.lead.ai_qualification || 'unscored',
}

/**
 * Replace {{variable}} placeholders with actual lead/org data.
 */
export function processTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
    const resolver = VARIABLE_MAP[varName]
    if (resolver) return resolver(ctx)
    // Check custom_fields
    if (ctx.lead.custom_fields && varName in ctx.lead.custom_fields) {
      return String(ctx.lead.custom_fields[varName])
    }
    return match // Leave unresolved variables as-is
  })
}

/**
 * Build a template context from a lead and organization data.
 *
 * When `branding` is supplied, `practice_name` resolves to the lead's
 * per-service-line DBA (implants → Dion Health, TMJ/sleep → TMJ center, else →
 * SF Dentistry) instead of the raw org name — so a {{practice_name}} merge in a
 * template blast brands each recipient correctly. Omitting `branding` keeps the
 * legacy behaviour (raw org name) for callers that have no lead/brand context.
 */
export function buildTemplateContext(
  lead: Partial<Lead>,
  orgName: string,
  orgId: string,
  branding?: Branding
): TemplateContext {
  const practice_name = branding
    ? resolveBrandForContext(branding, orgName, { lead: lead as Lead }).practiceName
    : orgName
  return {
    lead,
    practice_name,
    org_id: orgId,
    app_url: process.env.NEXT_PUBLIC_APP_URL || 'https://lead-intelligence-jet.vercel.app',
  }
}
