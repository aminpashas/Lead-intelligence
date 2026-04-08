import type { Lead } from '@/types/database'

type TemplateContext = {
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
 */
export function buildTemplateContext(
  lead: Partial<Lead>,
  orgName: string,
  orgId: string
): TemplateContext {
  return {
    lead,
    practice_name: orgName,
    org_id: orgId,
    app_url: process.env.NEXT_PUBLIC_APP_URL || 'https://lead-intelligence-jet.vercel.app',
  }
}
