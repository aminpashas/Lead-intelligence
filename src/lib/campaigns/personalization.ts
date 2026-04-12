/**
 * Broadcast Personalization Engine
 *
 * Central place for all template variable definitions and
 * the personalize() function used by both Mass SMS and Mass Email APIs.
 */

/** Available template variables with metadata for the UI */
export const TEMPLATE_VARIABLES = [
  // Identity
  { var: '{{first_name}}', label: 'First Name', category: 'identity', example: 'John' },
  { var: '{{last_name}}', label: 'Last Name', category: 'identity', example: 'Smith' },
  { var: '{{full_name}}', label: 'Full Name', category: 'identity', example: 'John Smith' },
  { var: '{{email}}', label: 'Email', category: 'identity', example: 'john@example.com' },
  { var: '{{phone}}', label: 'Phone', category: 'identity', example: '(555) 123-4567' },

  // Location
  { var: '{{city}}', label: 'City', category: 'location', example: 'Los Angeles' },
  { var: '{{state}}', label: 'State', category: 'location', example: 'CA' },
  { var: '{{zip_code}}', label: 'Zip Code', category: 'location', example: '90210' },

  // Clinical
  { var: '{{condition}}', label: 'Dental Condition', category: 'clinical', example: 'multiple missing teeth' },
  { var: '{{condition_details}}', label: 'Condition Details', category: 'clinical', example: 'upper arch replacement' },

  // Pipeline & Scoring
  { var: '{{status}}', label: 'Lead Status', category: 'pipeline', example: 'active' },
  { var: '{{ai_score}}', label: 'AI Score', category: 'pipeline', example: '87' },
  { var: '{{engagement_score}}', label: 'Engagement Score', category: 'pipeline', example: '72' },
  { var: '{{qualification}}', label: 'AI Qualification', category: 'pipeline', example: 'Hot' },

  // Source
  { var: '{{source_type}}', label: 'Lead Source', category: 'source', example: 'Google Ads' },

  // Financial
  { var: '{{treatment_value}}', label: 'Treatment Value', category: 'financial', example: '$25,000' },
  { var: '{{budget_range}}', label: 'Budget Range', category: 'financial', example: '$15k-$25k' },

  // Scheduling
  { var: '{{consultation_date}}', label: 'Consultation Date', category: 'scheduling', example: 'April 15, 2026' },
] as const

export type TemplateVariable = typeof TEMPLATE_VARIABLES[number]

/** Categories for grouping in the UI */
export const VARIABLE_CATEGORIES = [
  { id: 'identity', label: 'Identity', icon: 'user' },
  { id: 'location', label: 'Location', icon: 'map-pin' },
  { id: 'clinical', label: 'Clinical', icon: 'heart' },
  { id: 'pipeline', label: 'Pipeline & Score', icon: 'bar-chart' },
  { id: 'source', label: 'Source', icon: 'globe' },
  { id: 'financial', label: 'Financial', icon: 'dollar-sign' },
  { id: 'scheduling', label: 'Scheduling', icon: 'calendar' },
] as const

/**
 * Lead data shape expected by personalize().
 * This is the subset of Lead columns fetched by the mass broadcast APIs.
 */
export interface PersonalizableLead {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  phone_formatted: string | null
  city: string | null
  state: string | null
  zip_code: string | null
  dental_condition: string | null
  dental_condition_details: string | null
  status: string
  ai_score: number
  ai_qualification: string
  engagement_score: number
  source_type: string | null
  treatment_value: number | null
  budget_range: string | null
  consultation_date: string | null
  sms_opt_out?: boolean
  email_opt_out?: boolean
}

/** The SELECT clause for fetching personalizable lead data from Supabase */
export const PERSONALIZABLE_LEAD_SELECT =
  'id, first_name, last_name, email, phone, phone_formatted, city, state, zip_code, ' +
  'dental_condition, dental_condition_details, status, ai_score, ai_qualification, ' +
  'engagement_score, source_type, treatment_value, budget_range, consultation_date, ' +
  'sms_opt_out, email_opt_out'

/**
 * Replace all template variables in a string with actual lead data.
 */
export function personalize(template: string, lead: PersonalizableLead): string {
  const firstName = lead.first_name || ''
  const lastName = lead.last_name || ''

  return template
    // Identity
    .replace(/\{\{first_name\}\}/gi, firstName)
    .replace(/\{\{last_name\}\}/gi, lastName)
    .replace(/\{\{full_name\}\}/gi, `${firstName} ${lastName}`.trim())
    .replace(/\{\{email\}\}/gi, lead.email || '')
    .replace(/\{\{phone\}\}/gi, lead.phone || lead.phone_formatted || '')
    // Location
    .replace(/\{\{city\}\}/gi, lead.city || '')
    .replace(/\{\{state\}\}/gi, lead.state || '')
    .replace(/\{\{zip_code\}\}/gi, lead.zip_code || '')
    // Clinical
    .replace(/\{\{condition\}\}/gi, lead.dental_condition?.replace(/_/g, ' ') || '')
    .replace(/\{\{condition_details\}\}/gi, lead.dental_condition_details || '')
    // Pipeline & Scoring
    .replace(/\{\{status\}\}/gi, lead.status?.replace(/_/g, ' ') || '')
    .replace(/\{\{ai_score\}\}/gi, String(lead.ai_score ?? ''))
    .replace(/\{\{engagement_score\}\}/gi, String(lead.engagement_score ?? ''))
    .replace(/\{\{qualification\}\}/gi, lead.ai_qualification ? lead.ai_qualification.charAt(0).toUpperCase() + lead.ai_qualification.slice(1) : '')
    // Source
    .replace(/\{\{source_type\}\}/gi, lead.source_type?.replace(/_/g, ' ') || '')
    // Financial
    .replace(/\{\{treatment_value\}\}/gi, lead.treatment_value ? `$${lead.treatment_value.toLocaleString()}` : '')
    .replace(/\{\{budget_range\}\}/gi, lead.budget_range?.replace(/_/g, ' ') || '')
    // Scheduling
    .replace(/\{\{consultation_date\}\}/gi, lead.consultation_date ? new Date(lead.consultation_date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '')
}

/**
 * Preview personalize: uses example data instead of real lead data.
 */
export function previewPersonalize(template: string): string {
  let result = template
  for (const v of TEMPLATE_VARIABLES) {
    result = result.replace(new RegExp(v.var.replace(/[{}]/g, '\\$&'), 'gi'), v.example)
  }
  return result
}
