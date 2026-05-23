import type { PayloadRequest } from 'payload'

// ─── Audit logging helpers ───────────────────────────────────────────

const MAX_LOGGED_STRING = 200

/**
 * Returns the top-level keys of a JSON-string `data` arg, sanitized.
 * Per the Codex post-planning finding: logging key names (not values) lets us
 * later analyze whether the prose-only input shape is causing AI mistakes.
 */
export function extractDataKeys(args: Record<string, unknown>): string[] | undefined {
  const data = args.data
  if (typeof data !== 'string') return undefined
  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>)
    }
  } catch {
    return undefined
  }
  return undefined
}

export function summariseArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > MAX_LOGGED_STRING) {
      out[k] = `<truncated:${v.length}>`
    } else {
      out[k] = v
    }
  }
  return out
}

export function getRequestId(req: PayloadRequest): string | undefined {
  const headers = req.headers as Headers | undefined
  return headers?.get?.('x-request-id') ?? undefined
}

type LoggerLike = Partial<Record<'info' | 'warn' | 'error', (...args: unknown[]) => unknown>>

/**
 * Returns a logger-invoker that swallows transport failures. Audit-log
 * writes must never break the tool dispatch path — a throwing logger
 * transport (closed stream during HMR, a custom pino dest) would otherwise
 * flip a success to isError or mask the real tool error.
 */
export function makeSafeLog(logger: LoggerLike | undefined) {
  return (
    level: 'info' | 'warn' | 'error',
    payload: Record<string, unknown>,
    message: string,
  ) => {
    try {
      logger?.[level]?.(payload, message)
    } catch {
      // Logger transport failure must not break dispatch.
    }
  }
}
