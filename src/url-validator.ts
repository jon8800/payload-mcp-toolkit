import dns from 'node:dns'
import { Buffer } from 'node:buffer'

const MAX_REDIRECTS = 3
const FETCH_TIMEOUT_MS = 10_000

interface ValidatedFetchResult {
  buffer: Buffer
  contentType: string
  filename: string
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 // 50MB hard ceiling — caller may pass a tighter cap.

/**
 * Check whether an IP address falls within a private/reserved range.
 *
 * Blocks (IPv4): 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10 (CGNAT),
 * 127.0.0.0/8, 169.254.0.0/16 (link-local + AWS metadata),
 * 172.16.0.0/12, 192.168.0.0/16.
 *
 * Blocks (IPv6): ::1 (loopback, in any expanded form), fc00::/7
 * (unique local), fe80::/10 (link-local), and any IPv4-mapped or
 * IPv4-compatible address whose embedded IPv4 falls in a blocked range.
 */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) return isPrivateIpV6(ip)
  return isPrivateIpV4(ip)
}

function isPrivateIpV4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const [a, b] = parts.map(Number)
  if (parts.some((p) => Number.isNaN(Number(p)))) return false

  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 — CGNAT
  if (a === 127) return true // 127.0.0.0/8
  if (a === 169 && b === 254) return true // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16

  return false
}

function isPrivateIpV6(ip: string): boolean {
  const normalized = ip.toLowerCase()

  // IPv4-mapped (::ffff:1.2.3.4) and IPv4-compatible (::1.2.3.4) — extract
  // the embedded v4 and run the v4 checks against it.
  const mappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mappedMatch) return isPrivateIpV4(mappedMatch[1]!)
  const compatMatch = normalized.match(/^::(\d+\.\d+\.\d+\.\d+)$/)
  if (compatMatch) return isPrivateIpV4(compatMatch[1]!)

  // Expand to full 8-group form so loopback/link-local checks aren't
  // defeated by alternate notations (`0:0:0:0:0:0:0:1`, `0000:...:0001`).
  const groups = expandIpV6(normalized)
  if (!groups) return false

  // Loopback ::1
  if (groups.every((g, i) => (i < 7 ? g === 0 : g === 1))) return true

  const first = groups[0]!
  // fc00::/7 — unique local (fc00–fdff)
  if ((first & 0xfe00) === 0xfc00) return true
  // fe80::/10 — link-local
  if ((first & 0xffc0) === 0xfe80) return true

  return false
}

/**
 * Expand a textual IPv6 address into 8 numeric groups. Returns null if
 * the address isn't a recognisable v6 string (we err toward "not private"
 * for unparseable input — DNS already gave us a real address, this guards
 * notation variance, not malicious DNS payloads).
 */
function expandIpV6(ip: string): number[] | null {
  if (ip.includes('.')) return null // mapped/compat handled above
  const halves = ip.split('::')
  if (halves.length > 2) return null

  const parse = (segment: string): number[] | null => {
    if (segment === '') return []
    const out: number[] = []
    for (const piece of segment.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null
      out.push(parseInt(piece, 16))
    }
    return out
  }

  if (halves.length === 1) {
    const parts = parse(ip)
    return parts && parts.length === 8 ? parts : null
  }

  const head = parse(halves[0]!)
  const tail = parse(halves[1]!)
  if (!head || !tail) return null
  const fillCount = 8 - head.length - tail.length
  if (fillCount < 0) return null
  return [...head, ...new Array(fillCount).fill(0), ...tail]
}

/**
 * Validate a URL for SSRF safety and fetch its contents.
 *
 * - HTTPS-only scheme validation
 * - DNS resolution pre-check to block private/reserved IPs
 * - Manual redirect following with IP re-validation at each hop
 * - 10-second timeout
 *
 * NOTE: Small TOCTOU gap between DNS resolution and the actual TCP
 * connection (DNS rebinding). A future improvement could use a custom
 * http.Agent with a `lookup` override to validate IPs at connection time.
 */
export async function validateAndFetchUrl(
  url: string,
  options?: { maxRedirects?: number; timeoutMs?: number; maxBytes?: number },
): Promise<ValidatedFetchResult> {
  const maxRedirects = options?.maxRedirects ?? MAX_REDIRECTS
  const timeoutMs = options?.timeoutMs ?? FETCH_TIMEOUT_MS
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES

  let currentUrl = url
  let redirectCount = 0

  while (true) {
    const parsed = new URL(currentUrl)

    if (parsed.protocol !== 'https:') {
      throw new Error(`Only HTTPS URLs are allowed. Received: ${parsed.protocol}`)
    }

    const hostname = parsed.hostname
    const { address } = await dns.promises.lookup(hostname)

    if (isPrivateIp(address)) {
      throw new Error(
        `SSRF blocked: hostname "${hostname}" resolves to private IP ${address}. ` +
          'Only public internet addresses are allowed.',
      )
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await fetch(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'payload-mcp-toolkit/0.1' },
      })
    } catch (error) {
      clearTimeout(timer)
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeoutMs}ms fetching ${currentUrl}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        throw new Error(`Redirect response (${response.status}) missing Location header.`)
      }

      redirectCount++
      if (redirectCount > maxRedirects) {
        throw new Error(`Too many redirects (max ${maxRedirects}). Last URL: ${currentUrl}`)
      }

      currentUrl = new URL(location, currentUrl).href
      continue
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch ${currentUrl}: HTTP ${response.status} ${response.statusText}`)
    }

    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''

    // Reject early if the server advertises a body larger than maxBytes.
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null) {
      const length = Number(declaredLength)
      if (Number.isFinite(length) && length > maxBytes) {
        throw new Error(
          `Response body exceeds ${maxBytes} bytes (Content-Length: ${length}).`,
        )
      }
    }

    // Stream the body, enforcing the cap as we go so a server that lies
    // (or omits) Content-Length cannot exhaust memory.
    const buffer = await readBodyWithLimit(response, maxBytes, currentUrl)
    const filename = deriveFilename(parsed.pathname, contentType)

    return { buffer, contentType, filename }
  }
}

async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new Error(`Response body from ${url} exceeded ${maxBytes} bytes during streaming.`)
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Reader already released after the stream errored; nothing to do.
    }
  }
  return Buffer.concat(chunks, total)
}

/**
 * Derive a safe filename from a URL path segment, falling back to a
 * UUID-based name using the Content-Type for the extension.
 */
function deriveFilename(pathname: string, contentType: string): string {
  const lastSegment = pathname.split('/').filter(Boolean).pop() ?? ''

  const cleaned = lastSegment
    .replace(/[?#].*/g, '')
    .replace(/\.\./g, '')
    .replace(/[/\\]/g, '')

  if (cleaned && cleaned.includes('.') && cleaned.length <= 200) {
    return cleaned
  }

  const extMap: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
  }
  const ext = extMap[contentType] ?? '.bin'
  return `${crypto.randomUUID()}${ext}`
}
