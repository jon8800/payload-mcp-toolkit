import dns from 'node:dns'
import { Buffer } from 'node:buffer'

const MAX_REDIRECTS = 3
const FETCH_TIMEOUT_MS = 10_000

interface ValidatedFetchResult {
  buffer: Buffer
  contentType: string
  filename: string
}

/**
 * Check whether an IP address falls within a private/reserved range.
 *
 * Blocks: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8,
 * 169.254.0.0/16, 0.0.0.0, ::1, fc00::/7, fe80::/10
 */
export function isPrivateIp(ip: string): boolean {
  // IPv4
  const v4Parts = ip.split('.')
  if (v4Parts.length === 4) {
    const [a, b] = v4Parts.map(Number)

    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 0 && b === 0 && Number(v4Parts[2]) === 0 && Number(v4Parts[3]) === 0) return true

    return false
  }

  // IPv6
  const normalized = ip.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (normalized.startsWith('fe80')) return true

  return false
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
  options?: { maxRedirects?: number; timeoutMs?: number },
): Promise<ValidatedFetchResult> {
  const maxRedirects = options?.maxRedirects ?? MAX_REDIRECTS
  const timeoutMs = options?.timeoutMs ?? FETCH_TIMEOUT_MS

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
    const buffer = Buffer.from(await response.arrayBuffer())
    const filename = deriveFilename(parsed.pathname, contentType)

    return { buffer, contentType, filename }
  }
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
