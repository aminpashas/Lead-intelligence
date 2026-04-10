import type { LenderAdapter, LenderSlug } from '../types'
import { CareCreditAdapter } from './carecredit'
import { SunbitAdapter } from './sunbit'
import { ProceedAdapter } from './proceed'
import { LendingClubAdapter } from './lendingclub'
import { CherryAdapter } from './cherry'
import { AlpheonAdapter } from './alpheon'
import { AffirmAdapter } from './affirm'

/**
 * Registry of all available lender adapters.
 * Each adapter implements the LenderAdapter interface with
 * lender-specific API calls or link generation.
 */
export const LENDER_ADAPTERS: Record<LenderSlug, LenderAdapter> = {
  carecredit: new CareCreditAdapter(),
  sunbit: new SunbitAdapter(),
  proceed: new ProceedAdapter(),
  lendingclub: new LendingClubAdapter(),
  cherry: new CherryAdapter(),
  alpheon: new AlpheonAdapter(),
  affirm: new AffirmAdapter(),
}

/**
 * Get a lender adapter by slug.
 * Throws if the lender slug is not recognized.
 */
export function getLenderAdapter(slug: LenderSlug): LenderAdapter {
  const adapter = LENDER_ADAPTERS[slug]
  if (!adapter) {
    throw new Error(`Unknown lender: ${slug}`)
  }
  return adapter
}

/**
 * Get all lender adapters as an ordered array.
 */
export function getAllLenderAdapters(): LenderAdapter[] {
  return Object.values(LENDER_ADAPTERS)
}

/**
 * Lender display information for the UI.
 */
export const LENDER_INFO: Record<LenderSlug, {
  name: string
  description: string
  integrationType: 'api' | 'link' | 'iframe'
  features: string[]
  credentialFields: Array<{ key: string; label: string; type: 'text' | 'password' }>
  configFields: Array<{ key: string; label: string; type: 'text' | 'password'; placeholder?: string }>
}> = {
  carecredit: {
    name: 'CareCredit',
    description: 'Healthcare credit card by Synchrony. Pre-qualification with soft pull, promotional financing terms.',
    integrationType: 'api',
    features: ['Soft credit pull', 'Instant decision', 'Promotional 0% APR', 'Webhook notifications'],
    credentialFields: [
      { key: 'client_id', label: 'OAuth Client ID', type: 'text' },
      { key: 'client_secret', label: 'OAuth Client Secret', type: 'password' },
      { key: 'api_base_url', label: 'API Base URL', type: 'text' },
    ],
    configFields: [
      { key: 'merchant_id', label: 'Merchant ID', type: 'text', placeholder: 'Your CareCredit merchant number' },
      { key: 'partner_code', label: 'Partner Code', type: 'text', placeholder: 'Technology partner code' },
    ],
  },
  sunbit: {
    name: 'Sunbit',
    description: 'Point-of-sale dental financing. Payment estimation API and pre-qualification links.',
    integrationType: 'api',
    features: ['Payment estimates', 'Pre-qualification link', '90% approval rate', 'Webhook notifications'],
    credentialFields: [
      { key: 'api_token', label: 'API Token', type: 'password' },
      { key: 'api_base_url', label: 'API Base URL', type: 'text' },
    ],
    configFields: [
      { key: 'location_id', label: 'Location ID', type: 'text', placeholder: 'Your Sunbit location ID' },
    ],
  },
  proceed: {
    name: 'Proceed Finance',
    description: 'Multi-lender dental financing platform. Submits to multiple lenders through one application.',
    integrationType: 'link',
    features: ['Multi-lender network', 'One application', 'Wide credit range'],
    credentialFields: [],
    configFields: [
      { key: 'provider_office_code', label: 'Provider Office Code', type: 'text', placeholder: 'Your Proceed Finance office code' },
      { key: 'provider_portal_url', label: 'Provider Portal URL', type: 'text', placeholder: 'https://portal.proceedfinance.com/...' },
    ],
  },
  lendingclub: {
    name: 'LendingClub',
    description: 'Fixed-rate patient installment loans. Simple application process with competitive rates.',
    integrationType: 'link',
    features: ['Fixed-rate loans', 'No prepayment penalties', 'Terms up to 84 months'],
    credentialFields: [],
    configFields: [
      { key: 'provider_id', label: 'Provider ID', type: 'text', placeholder: 'Your LendingClub provider ID' },
      { key: 'provider_portal_url', label: 'Provider Portal URL', type: 'text', placeholder: 'https://www.lendingclub.com/patientsolutions/...' },
    ],
  },
  cherry: {
    name: 'Cherry',
    description: 'Point-of-sale patient financing with high approval rates and promotional 0% APR terms.',
    integrationType: 'link',
    features: ['High approval rate (~80%)', 'Promotional 0% APR', 'Up to $50K', 'Simple patient application'],
    credentialFields: [],
    configFields: [
      { key: 'practice_id', label: 'Practice ID', type: 'text', placeholder: 'Your Cherry practice ID' },
      { key: 'portal_url', label: 'Staff Portal URL', type: 'text', placeholder: 'https://provider.withcherry.com/...' },
    ],
  },
  alpheon: {
    name: 'Alpheon Credit',
    description: 'Competitive fixed-rate dental financing with terms up to 84 months. No prepayment penalties.',
    integrationType: 'link',
    features: ['Fixed rates from 4.99%', 'Up to $100K', 'Terms up to 84 months', 'No prepayment penalties'],
    credentialFields: [],
    configFields: [
      { key: 'provider_id', label: 'Provider ID', type: 'text', placeholder: 'Your Alpheon provider ID' },
      { key: 'portal_url', label: 'Staff Portal URL', type: 'text', placeholder: 'https://portal.alpheoncredit.com/...' },
    ],
  },
  affirm: {
    name: 'Affirm',
    description: 'Transparent buy-now-pay-later financing. 0% APR promotional options, no hidden fees.',
    integrationType: 'link',
    features: ['0% APR promos', 'Transparent terms', 'No hidden fees', 'Soft credit check pre-qual'],
    credentialFields: [],
    configFields: [
      { key: 'merchant_id', label: 'Merchant ID', type: 'text', placeholder: 'Your Affirm merchant ID' },
      { key: 'public_api_key', label: 'Public API Key', type: 'text', placeholder: 'Your Affirm public API key' },
    ],
  },
}
