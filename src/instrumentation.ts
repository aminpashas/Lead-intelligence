/**
 * Next.js instrumentation — runs once when the server starts.
 * Used for environment validation and startup checks.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { logEnvValidation } = await import('@/lib/env')
    logEnvValidation()
  }
}
