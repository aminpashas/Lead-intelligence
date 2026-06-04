/**
 * Structured logger for production observability.
 * Outputs JSON in production for log aggregation (Vercel, Datadog, etc.).
 * Outputs human-readable format in development.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogContext = Record<string, unknown>

interface LogEntry {
  level: LogLevel
  message: string
  timestamp: string
  context?: LogContext
  error?: {
    message: string
    stack?: string
    name: string
  }
}

const IS_PRODUCTION = process.env.NODE_ENV === 'production'

// Keys whose values are masked entirely (secrets / direct identifiers).
const REDACT_KEYS = /(?:authorization|cookie|password|secret|token|api[_-]?key|bearer|ssn|email|phone|first_name|last_name|full_name|patient_name|address|dob)/i

function maskValue(val: string): string {
  if (val.length <= 4) return '***'
  return `${val.slice(0, 2)}***${val.slice(-2)}`
}

/** Recursively redact PII/secret-looking fields from a log context object. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.test(k) ? (typeof v === 'string' ? maskValue(v) : '***') : redact(v, depth + 1)
    }
    return out
  }
  return value
}

function formatEntry(entry: LogEntry): string {
  if (IS_PRODUCTION) {
    return JSON.stringify(entry)
  }
  // Dev: human-readable
  const ctx = entry.context ? ` ${JSON.stringify(entry.context)}` : ''
  const err = entry.error ? ` [${entry.error.name}: ${entry.error.message}]` : ''
  return `[${entry.level.toUpperCase()}] ${entry.message}${ctx}${err}`
}

function log(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
  const entry: LogEntry = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(context && Object.keys(context).length > 0 ? { context: redact(context) as LogContext } : {}),
    ...(error ? { error: { message: error.message, stack: error.stack, name: error.name } } : {}),
  }

  const formatted = formatEntry(entry)

  switch (level) {
    case 'debug':
      if (!IS_PRODUCTION) console.debug(formatted)
      break
    case 'info':
      console.log(formatted)
      break
    case 'warn':
      console.warn(formatted)
      break
    case 'error':
      console.error(formatted)
      break
  }
}

export const logger = {
  debug: (message: string, context?: LogContext) => log('debug', message, context),
  info: (message: string, context?: LogContext) => log('info', message, context),
  warn: (message: string, context?: LogContext) => log('warn', message, context),
  error: (message: string, context?: LogContext, error?: Error) => log('error', message, context, error),
}
