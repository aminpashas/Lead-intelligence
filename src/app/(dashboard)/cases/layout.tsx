import { redirect } from 'next/navigation'

/**
 * Cases module retired in LI (2026-07) — clinical fulfillment lives in Dion
 * Clinical per the ecosystem split. The index page already redirects, but
 * /cases/new and /cases/[id] were still fully reachable; this layout covers
 * the entire /cases subtree. Reversible: delete this file (and the index
 * redirect) to restore the module.
 */
export default function CasesLayout() {
  redirect('/dashboard')
}
