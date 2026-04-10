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
    ...(context && Object.keys(context).length > 0 ? { context } : {}),
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
