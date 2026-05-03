import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import dns from 'node:dns'
import { isPrivateIp, validateAndFetchUrl } from '../url-validator'

// ─── isPrivateIp — pure unit tests ────────────────────────────────

describe('isPrivateIp', () => {
  describe('IPv4 — blocked ranges', () => {
    it.each([
      ['10.0.0.1', '10.0.0.0/8'],
      ['10.255.255.255', '10.0.0.0/8 upper'],
      ['172.16.0.1', '172.16.0.0/12 lower'],
      ['172.20.5.5', '172.16.0.0/12 mid'],
      ['172.31.255.255', '172.16.0.0/12 upper'],
      ['192.168.1.1', '192.168.0.0/16'],
      ['127.0.0.1', '127.0.0.0/8 loopback'],
      ['127.255.255.255', '127.0.0.0/8 upper'],
      ['169.254.169.254', '169.254.0.0/16 — AWS metadata'],
      ['0.0.0.0', 'unspecified — 0.0.0.0/8'],
      ['0.0.0.1', '0.0.0.0/8 not just :0'],
      ['0.255.255.255', '0.0.0.0/8 upper'],
      ['100.64.0.0', '100.64.0.0/10 — CGNAT lower'],
      ['100.100.50.50', '100.64.0.0/10 — CGNAT mid'],
      ['100.127.255.255', '100.64.0.0/10 — CGNAT upper'],
    ])('blocks %s (%s)', (ip) => {
      expect(isPrivateIp(ip)).toBe(true)
    })
  })

  describe('IPv4 — public (allowed)', () => {
    it.each([
      ['8.8.8.8'],
      ['1.1.1.1'],
      ['172.15.0.1'], // just outside 172.16/12
      ['172.32.0.1'], // just outside 172.16/12
      ['11.0.0.1'],
      ['192.169.1.1'], // not 192.168
      ['126.255.255.255'],
      ['128.0.0.1'],
      ['100.63.255.255'], // just below CGNAT
      ['100.128.0.0'], // just above CGNAT
      ['1.0.0.1'], // outside 0.0.0.0/8
    ])('allows %s', (ip) => {
      expect(isPrivateIp(ip)).toBe(false)
    })
  })

  describe('IPv6 — blocked ranges', () => {
    it.each([
      ['::1', 'loopback shorthand'],
      ['0:0:0:0:0:0:0:1', 'loopback expanded'],
      ['0000:0000:0000:0000:0000:0000:0000:0001', 'loopback fully expanded'],
      ['fc00::1', 'unique local fc'],
      ['fd12:3456:789a::1', 'unique local fd'],
      ['fe80::1', 'link-local'],
      ['FE80::1', 'link-local case-insensitive'],
      ['febf::1', 'link-local upper boundary fe80::/10'],
      ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
      ['::ffff:10.0.0.1', 'IPv4-mapped private 10/8'],
      ['::ffff:169.254.169.254', 'IPv4-mapped AWS metadata'],
      ['::ffff:100.64.0.1', 'IPv4-mapped CGNAT'],
      ['::127.0.0.1', 'IPv4-compat loopback'],
    ])('blocks %s (%s)', (ip) => {
      expect(isPrivateIp(ip)).toBe(true)
    })
  })

  describe('IPv6 — public (allowed)', () => {
    it.each([
      ['2001:4860:4860::8888'], // Google DNS
      ['2606:4700:4700::1111'], // Cloudflare DNS
      ['ff00::1'], // multicast — not in our private blocklist
      ['::ffff:8.8.8.8'], // IPv4-mapped public
      ['fec0::1'], // outside fe80::/10 (deprecated site-local, but not our match)
    ])('allows %s', (ip) => {
      expect(isPrivateIp(ip)).toBe(false)
    })
  })
})

// ─── validateAndFetchUrl — integration with mocked DNS + fetch ────

describe('validateAndFetchUrl', () => {
  const originalFetch = globalThis.fetch
  let dnsLookupSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dnsLookupSpy = vi.spyOn(dns.promises, 'lookup')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
  })

  function mockDns(address: string, family: 4 | 6 = 4) {
    dnsLookupSpy.mockResolvedValue({ address, family } as any)
  }

  function mockFetch(impl: (url: string) => Promise<Response> | Response) {
    globalThis.fetch = vi.fn(((url: any) => Promise.resolve(impl(String(url)))) as any) as any
  }

  it('rejects non-HTTPS schemes', async () => {
    await expect(validateAndFetchUrl('http://example.com/x.png')).rejects.toThrow(/HTTPS/)
  })

  it('rejects when DNS resolves to a private IPv4 (SSRF)', async () => {
    mockDns('10.0.0.5')
    await expect(validateAndFetchUrl('https://attacker.example/x.png')).rejects.toThrow(
      /SSRF blocked/,
    )
  })

  it('rejects when DNS resolves to AWS metadata IP (SSRF)', async () => {
    mockDns('169.254.169.254')
    await expect(validateAndFetchUrl('https://metadata.example/x.png')).rejects.toThrow(
      /SSRF blocked/,
    )
  })

  it('rejects when DNS resolves to ::1 (SSRF)', async () => {
    mockDns('::1', 6)
    await expect(validateAndFetchUrl('https://localhost.example/x.png')).rejects.toThrow(
      /SSRF blocked/,
    )
  })

  it('fetches successfully when DNS resolves to a public IP', async () => {
    mockDns('8.8.8.8')
    mockFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    )

    const result = await validateAndFetchUrl('https://example.com/cat.png')
    expect(result.contentType).toBe('image/png')
    expect(result.filename).toBe('cat.png')
    expect(result.buffer.length).toBe(3)
  })

  it('follows redirects and re-validates the redirect target', async () => {
    let call = 0
    // First lookup: public. Second lookup (after redirect): private → must block.
    dnsLookupSpy.mockImplementation(async () => {
      call++
      return { address: call === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 } as any
    })

    mockFetch((url) => {
      if (url === 'https://example.com/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://internal.example/secret' },
        })
      }
      throw new Error(`should not reach ${url} — redirect target must be blocked`)
    })

    await expect(validateAndFetchUrl('https://example.com/start')).rejects.toThrow(
      /SSRF blocked/,
    )
    expect(call).toBe(2)
  })

  it('caps redirect chains at maxRedirects', async () => {
    mockDns('8.8.8.8')
    mockFetch(
      (url) =>
        new Response(null, {
          status: 302,
          headers: { location: url + '/again' },
        }),
    )

    await expect(
      validateAndFetchUrl('https://example.com/loop', { maxRedirects: 2 }),
    ).rejects.toThrow(/Too many redirects/)
  })

  it('errors when a redirect response has no Location header', async () => {
    mockDns('8.8.8.8')
    mockFetch(() => new Response(null, { status: 302 }))

    await expect(validateAndFetchUrl('https://example.com/x.png')).rejects.toThrow(
      /Location header/,
    )
  })

  it('surfaces non-OK HTTP responses', async () => {
    mockDns('8.8.8.8')
    mockFetch(() => new Response(null, { status: 404, statusText: 'Not Found' }))

    await expect(validateAndFetchUrl('https://example.com/x.png')).rejects.toThrow(/404/)
  })

  it('derives a UUID filename when the URL path has no extension', async () => {
    mockDns('8.8.8.8')
    mockFetch(
      () =>
        new Response(new Uint8Array([0]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
    )

    const result = await validateAndFetchUrl('https://example.com/no-extension')
    expect(result.filename).toMatch(/\.jpg$/)
    expect(result.filename).not.toBe('no-extension')
  })

  it('strips path traversal segments from derived filenames', async () => {
    mockDns('8.8.8.8')
    mockFetch(
      () =>
        new Response(new Uint8Array([0]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    )

    const result = await validateAndFetchUrl('https://example.com/foo/..%2Fevil.png')
    // URL parser decodes %2F into /, so lastSegment ends up "..evil.png" after .. strip
    expect(result.filename).not.toContain('..')
    expect(result.filename).not.toContain('/')
    expect(result.filename).not.toContain('\\')
  })
})
