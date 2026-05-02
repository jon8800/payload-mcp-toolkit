/**
 * Simple in-memory sliding window rate limiter per API key.
 * State resets on server restart — not suitable for serverless.
 */

interface RateLimitEntry {
  timestamps: number[]
}

interface RateLimitOptions {
  /** Window duration in milliseconds (default: 60000 = 1 minute) */
  windowMs?: number
  /** Maximum requests per window (default: 60) */
  maxRequests?: number
}

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX_REQUESTS = 60

export function createRateLimiter(options?: RateLimitOptions) {
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS
  const maxRequests = options?.maxRequests ?? DEFAULT_MAX_REQUESTS
  const store = new Map<string, RateLimitEntry>()

  // Periodically clean up expired entries (every 5 minutes)
  const cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs)
      if (entry.timestamps.length === 0) store.delete(key)
    }
  }, 5 * 60_000)

  // Allow garbage collection if the module is unloaded
  if (cleanupInterval.unref) cleanupInterval.unref()

  return {
    /**
     * Check if a request is allowed for the given key.
     * Returns { allowed: true } or { allowed: false, retryAfterMs }.
     */
    check(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
      const now = Date.now()
      const entry = store.get(key) ?? { timestamps: [] }

      // Remove timestamps outside the window
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs)

      if (entry.timestamps.length >= maxRequests) {
        const oldest = entry.timestamps[0]
        const retryAfterMs = oldest + windowMs - now
        return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 1000) }
      }

      entry.timestamps.push(now)
      store.set(key, entry)
      return { allowed: true }
    },

    /** Reset the store (for testing) */
    reset() {
      store.clear()
    },
  }
}
