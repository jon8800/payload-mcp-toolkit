import { createHash } from 'node:crypto'
import type { Config, Payload, PayloadRequest } from 'payload'
import { describe, expect, it, vi } from 'vitest'
import { createOAuth, type OAuthOptions } from '../oauth'
import type { Catalog } from '../oauth-permissions'
import { consumeRecord, createOAuthCollection, OAUTH_COLLECTION, tokenKey, type OAuthRecord } from '../oauth-store'

const origin = 'https://cms.example.com'
const resource = `${origin}/api/mcp`
const callback = 'https://claude.ai/api/mcp/auth_callback'
const verifier = 'a'.repeat(43)
const challenge = createHash('sha256').update(verifier).digest('base64url')
const account = { id: 7, email: 'editor@example.com', collection: 'users', role: 'editor' }
const config = { serverURL: origin, collections: [{ slug: 'users', auth: true }] } as Config
const catalog: Catalog = { collections: ['posts', 'pages'], globals: ['settings'], tools: [
  { name: 'findDocument', kind: 'collection', action: 'read' },
  { name: 'updateDocument', kind: 'collection', action: 'update' },
  { name: 'deleteDocument', kind: 'collection', action: 'delete' },
  { name: 'searchContent', kind: 'account', action: 'read' },
] }

function duplicateError(collection = OAUTH_COLLECTION, path = 'key') {
  return Object.assign(new Error('Value must be unique'), {
    name: 'ValidationError', status: 400,
    data: { collection, errors: [{ message: 'Value must be unique', path }] },
  })
}

function setup(options: Partial<OAuthOptions> = {}, configOverrides: Partial<Config> = {}) {
  const records = new Map<string, OAuthRecord>()
  const users = new Map<string, Record<string, unknown>>([[String(account.id), { ...account }]])
  let sequence = 0
  const find = vi.fn(async ({ collection, where }: any) => {
    if (collection === 'users') return { docs: [users.get(String(where.id.equals))].filter(Boolean) }
    if (where?.key) return { docs: [records.get(where.key.equals)].filter(Boolean) }
    return { docs: [...records.values()].filter(r => r.kind === 'grant' && Date.parse(r.expiresAt) > Date.now()) }
  })
  const create = vi.fn(async ({ data }: any) => {
    if (records.has(data.key)) throw duplicateError()
    const row = structuredClone({ ...data, id: ++sequence }) as OAuthRecord
    records.set(row.key, row)
    return row
  })
  const update = vi.fn(async ({ id, data }: any) => {
    const record = [...records.values()].find(r => r.id === id)
    if (!record) throw new Error('record not found')
    Object.assign(record, data)
    return record
  })
  const payload = { secret: 'test-secret', find, create, update, logger: { error: vi.fn() } } as unknown as Payload
  const canAuthorize = vi.fn((req: PayloadRequest) => (req.user as any)?.role === 'editor')
  const oauth = createOAuth({ canAuthorize, ...options }, { ...config, ...configOverrides }, 'users', catalog)

  function request(path: string, method = 'GET', body?: string, user: unknown = account, headers: Record<string, string> = {}) {
    return Object.assign(new Request(`${origin}/api/mcp/oauth${path}`, {
      method, ...(body === undefined ? {} : { body }),
      headers: { ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded', origin } : {}), ...headers },
    }), { payload, user }) as unknown as PayloadRequest
  }
  async function call(path: string, method = 'GET', body?: string, user: unknown = account, headers: Record<string, string> = {}) {
    const endpoint = oauth.endpoints.find(e => e.path === `/mcp/oauth${path.split('?')[0]}` && e.method === method.toLowerCase())!
    return endpoint.handler(request(path, method, body, user, headers)) as Promise<Response>
  }
  async function register(uri = callback) {
    const response = await call('/register', 'POST', JSON.stringify({ redirect_uris: [uri], token_endpoint_auth_method: 'none' }), null, { 'content-type': 'application/json' })
    expect(response.status).toBe(201)
    return (await response.json()).client_id as string
  }
  function authParams(client: string, overrides: Record<string, string> = {}) {
    return new URLSearchParams({ client_id: client, redirect_uri: callback, response_type: 'code', resource,
      code_challenge: challenge, code_challenge_method: 'S256', state: 'return-state', ...overrides })
  }
  async function consent(client: string, overrides: Record<string, string> = {}) {
    const response = await call(`/authorize?${authParams(client, overrides)}`, 'GET', undefined, account, { accept: 'application/json' })
    expect(response.status).toBe(200)
    return (await response.json()).consent as string
  }
  async function authorize(client: string, overrides: Record<string, string> = {}) {
    const approval = await consent(client, overrides)
    const response = await call('/authorize', 'POST', new URLSearchParams({ consent: approval, decision: 'allow' }).toString())
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin + location.pathname).toBe(callback)
    expect(location.searchParams.get('state')).toBe('return-state')
    expect(location.searchParams.get('iss')).toBe(origin)
    return location.searchParams.get('code')!
  }
  function exchange(client: string, code: string, overrides: Record<string, string> = {}) {
    return call('/token', 'POST', new URLSearchParams({ grant_type: 'authorization_code', client_id: client, code,
      redirect_uri: callback, resource, code_verifier: verifier, ...overrides }).toString(), null)
  }
  function refresh(client: string, token: string, overrides: Record<string, string> = {}) {
    return call('/token', 'POST', new URLSearchParams({ grant_type: 'refresh_token', client_id: client, refresh_token: token,
      resource, ...overrides }).toString(), null)
  }
  async function connected(overrides: Record<string, string> = {}) {
    const client = await register()
    const code = await authorize(client, overrides)
    const response = await exchange(client, code)
    expect(response.status).toBe(200)
    return { client, code, ...(await response.json()) }
  }
  function bearer(token: string) {
    return request('', 'GET', undefined, null, { authorization: `Bearer ${token}` })
  }
  return { records, users, payload, find, create, update, canAuthorize, oauth, request, call, register, authParams, consent,
    authorize, exchange, refresh, connected, bearer }
}

describe('OAuth website authorization', () => {
  it('advertises discovery, PKCE, public registration, expiry and read-only defaults', async () => {
    const f = setup()
    const metadata = await (await f.call('/metadata')).json()
    expect(metadata).toMatchObject({ issuer: origin, code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['mcp:read'],
      authorization_response_iss_parameter_supported: true })
    expect(await (await f.call('/resource')).json()).toMatchObject({ resource, authorization_servers: [origin] })
    expect(f.oauth.metadataURL).toBe(`${origin}/api/mcp/oauth/resource`)
    expect(f.oauth.scope).toBe('mcp:read')
    expect(setup({ access: 'editor' }).oauth.scope).toBe('mcp:read mcp:write')
    const tokens = await f.connected()
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read' })
    const req = f.bearer(tokens.access_token)
    expect(await f.oauth.authenticate(req)).toBe(true)
    expect(req.user).toMatchObject({ id: account.id, collection: 'users', _strategy: 'mcp-toolkit-oauth', _mcpKey: { scopes: { preset: 'read-only' } } })
    expect(JSON.stringify([...f.records.values()])).not.toContain(tokens.access_token)
    expect(JSON.stringify([...f.records.values()])).not.toContain(tokens.refresh_token)
  })

  it('returns the same public client for a trusted callback without storing registration rows', async () => {
    const f = setup()
    expect(await f.register()).toBe(await f.register())
    expect(f.records.size).toBe(0)
  })

  it('trusts the ChatGPT connector callback by default and names it on the consent screen', async () => {
    const f = setup()
    const chatgpt = 'https://chatgpt.com/connector_platform_oauth_redirect'
    const client = await f.register(chatgpt)
    expect(client).not.toBe(await f.register())
    const response = await f.call(`/authorize?${f.authParams(client, { redirect_uri: chatgpt })}`, 'GET', undefined, account, { accept: 'application/json' })
    expect((await response.json()).clientName).toBe('chatgpt.com')
  })

  it.each([
    { redirect_uris: ['https://evil.example/callback'] },
    { redirect_uris: [callback, 'https://evil.example/callback'] },
    { redirect_uris: [callback], token_endpoint_auth_method: 'client_secret_basic' },
    { redirect_uris: [callback], grant_types: ['password'] },
    { redirect_uris: [callback], response_types: ['token'] },
  ])('rejects unsupported client metadata: %j', async data => {
    const f = setup()
    const response = await f.call('/register', 'POST', JSON.stringify(data), null, { 'content-type': 'application/json' })
    expect(response.status).toBe(400)
    expect(f.records.size).toBe(0)
  })

  it.each([
    { redirect_uri: 'https://evil.example/callback' }, { client_id: 'unknown' },
    { resource: 'https://other.example/api/mcp' }, { code_challenge_method: 'plain' },
    { code_challenge: 'short' }, { response_type: 'token' },
  ])('rejects invalid authorization parameters before consent: %j', async params => {
    const f = setup()
    const response = await f.call(`/authorize?${f.authParams(await f.register(), params)}`)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.headers.get('location')).toBeNull()
    expect(f.records.size).toBe(0)
  })

  it.each([
    ['mcp:write', {}, 'mcp:read'],
    ['mcp:read offline_access openid mcp:read', {}, 'mcp:read'],
    ['openid email', { access: 'editor' as const }, 'mcp:read'],
    ['offline_access mcp:write mcp:read', { access: 'editor' as const }, 'mcp:read mcp:write'],
  ])('grants only supported scopes when %s is requested', async (scope, options, granted) => {
    const f = setup(options)
    const response = await f.call(`/authorize?${f.authParams(await f.register(), { scope })}`, 'GET', undefined, account, { accept: 'application/json' })
    expect((await response.json()).scope).toBe(granted)
  })

  it('keeps the stored scope when a refresh asks only for scopes the site does not grant', async () => {
    const f = setup({ access: 'editor' })
    const tokens = await f.connected({ scope: 'mcp:read mcp:write' })
    const refreshed = await (await f.refresh(tokens.client, tokens.refresh_token, { scope: 'offline_access' })).json()
    expect(refreshed.scope).toBe('mcp:read mcp:write')
    expect((await (await f.refresh(tokens.client, refreshed.refresh_token)).json()).scope).toBe('mcp:read mcp:write')
  })

  it('refreshes without a resource parameter but rejects a different one', async () => {
    const f = setup()
    const tokens = await f.connected()
    const refreshed = await f.call('/token', 'POST', new URLSearchParams({ grant_type: 'refresh_token', client_id: tokens.client,
      refresh_token: tokens.refresh_token }).toString(), null)
    expect(refreshed.status).toBe(200)
    const next = await refreshed.json()
    expect((await f.refresh(tokens.client, next.refresh_token, { resource: 'https://evil.example/api/mcp' })).status).toBe(400)
  })

  it('rejects duplicate authorization and token parameters', async () => {
    const f = setup()
    const client = await f.register()
    expect((await f.call(`/authorize?${f.authParams(client)}&resource=${resource}`)).status).toBe(400)
    expect((await f.call('/token', 'POST', `client_id=${client}&client_id=${client}`, null)).status).toBe(400)
  })

  it('sends unauthenticated users to the website login with a local return path', async () => {
    const f = setup()
    const query = f.authParams(await f.register()).toString()
    const response = await f.call(`/authorize?${query}`, 'GET', undefined, null)
    const location = new URL(response.headers.get('location')!)
    expect(response.status).toBe(303)
    expect(location.origin).toBe(origin)
    expect(location.pathname).toBe('/admin/login')
    expect(location.searchParams.get('redirect')).toBe(`/api/mcp/oauth/authorize?${query}`)
  })

  it.each(['/admin', '/cms'])('redirects browser consent to the Payload view under %s with every parameter intact', async admin => {
    const f = setup({}, { routes: { admin } })
    const params = f.authParams(await f.register(), { state: 'return + / ? & = state', scope: 'mcp:read' })
    const response = await f.call(`/authorize?${params}`)
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location')!)
    expect(location.origin).toBe(origin)
    expect(location.pathname).toBe(`${admin}/mcp-authorize`)
    expect([...location.searchParams]).toEqual([...params])
    expect(f.records.size).toBe(0)
  })

  it('returns uncached consent data for the Payload view', async () => {
    const f = setup()
    const response = await f.call(`/authorize?${f.authParams(await f.register())}`, 'GET', undefined, account, { accept: 'application/json' })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ consent: expect.any(String), clientName: expect.any(String), account: account.email, scope: 'mcp:read', catalog })
  })

  it.each(['/admin', '/cms'])('redirects browser connection management to the Payload view under %s', async admin => {
    const f = setup({}, { routes: { admin } })
    const response = await f.call('/connections')
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`${origin}${admin}/mcp-connections`)
  })

  it('returns uncached connection data for the Payload view', async () => {
    const f = setup()
    await f.connected()
    const response = await f.call('/connections', 'GET', undefined, account, { accept: 'application/json' })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toEqual({ resource, access: 'read-only', eligible: true, grants: [{ clientName: expect.any(String), scope: 'mcp:read', summary: 'Read only · all collections · all globals · all tools', consent: expect.any(String) }] })
  })

  it('rejects an external login URL instead of forwarding the authorization request', async () => {
    const f = setup({ loginURL: () => 'https://evil.example/login' })
    const response = await f.call(`/authorize?${f.authParams(await f.register())}`, 'GET', undefined, null)
    expect(response.status).toBe(400)
    expect(response.headers.get('location')).toBeNull()
  })

  it.each([
    { ...account, collection: 'customers' }, { ...account, _mcpKey: { scopes: null } },
    { ...account, role: 'member' },
  ])('does not let another collection, MCP key or denied account approve consent: %j', async user => {
    const f = setup()
    const client = await f.register()
    expect((await f.call(`/authorize?${f.authParams(client)}`, 'GET', undefined, user)).status).toBe(403)
    const approval = await f.consent(client)
    expect((await f.call('/authorize', 'POST', new URLSearchParams({ consent: approval, decision: 'allow' }).toString(), user)).status).toBe(403)
  })

  it('refuses Authorization headers during cookie consent, even with a valid website user', async () => {
    const f = setup()
    const client = await f.register()
    expect((await f.call(`/authorize?${f.authParams(client)}`, 'GET', undefined, account, { authorization: 'Bearer anything' })).status).toBe(403)
  })

  it.each(['https://evil.example', ''])('rejects consent from another or missing origin: %s', async value => {
    const f = setup()
    const approval = await f.consent(await f.register())
    expect((await f.call('/authorize', 'POST', new URLSearchParams({ consent: approval, decision: 'allow' }).toString(), account, { origin: value })).status).toBe(403)
    expect(f.records.size).toBe(0)
  })

  it('binds consent to the signed-in account and rejects tampering and expiry', async () => {
    const f = setup()
    const approval = await f.consent(await f.register())
    const submit = (value: string, user: unknown = account) => f.call('/authorize', 'POST', new URLSearchParams({ consent: value, decision: 'allow' }).toString(), user)
    expect((await submit(approval, { ...account, id: 8 })).status).toBe(403)
    expect((await submit(`${approval.slice(0, -1)}!`)).status).toBe(400)
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 601_000)
    try { expect((await submit(approval)).status).toBe(400) } finally { now.mockRestore() }
    expect(f.records.size).toBe(0)
  })

  it('allows cancelling without creating credentials and preserves OAuth state', async () => {
    const f = setup()
    const approval = await f.consent(await f.register())
    const response = await f.call('/authorize', 'POST', new URLSearchParams({ consent: approval, decision: 'deny' }).toString())
    const location = new URL(response.headers.get('location')!)
    expect(location.searchParams.get('error')).toBe('access_denied')
    expect(location.searchParams.get('state')).toBe('return-state')
    expect(location.searchParams.get('iss')).toBe(origin)
    expect(f.records.size).toBe(0)
  })

  it('consumes a signed consent only once under concurrent submission', async () => {
    const f = setup()
    const approval = await f.consent(await f.register())
    const responses = await Promise.all(Array.from({ length: 3 }, () => f.call('/authorize', 'POST', new URLSearchParams({ consent: approval, decision: 'allow' }).toString())))
    expect(responses.map(r => r.status).sort()).toEqual([303, 400, 400])
    expect([...f.records.values()].filter(r => r.kind === 'grant')).toHaveLength(1)
  })
})

describe('OAuth credentials and permissions', () => {
  it.each(['code', 'refresh'])('rejects an expired %s without issuing tokens', async kind => {
    const f = setup()
    const client = await f.register()
    const code = await f.authorize(client)
    let raw = code
    if (kind === 'refresh') raw = (await (await f.exchange(client, code)).json()).refresh_token
    f.records.get(tokenKey(f.payload, raw))!.expiresAt = new Date(0).toISOString()
    const response = kind === 'code' ? await f.exchange(client, raw) : await f.refresh(client, raw)
    expect(await response.json()).toEqual({ error: 'invalid_grant' })
  })

  it('rejects confidential client credentials at the public token endpoint', async () => {
    const f = setup()
    const client = await f.register()
    const code = await f.authorize(client)
    expect((await f.exchange(client, code, { client_secret: 'anything' })).status).toBe(401)
    const response = await f.call('/token', 'POST', new URLSearchParams({ client_id: client, grant_type: 'authorization_code' }).toString(), null, { authorization: 'Basic anything' })
    expect(response.status).toBe(401)
    expect((await f.exchange(client, code)).status).toBe(200)
  })

  it('never lets a refresh token authenticate MCP requests', async () => {
    const f = setup()
    const tokens = await f.connected()
    expect(await f.oauth.authenticate(f.bearer(tokens.refresh_token))).toBe(false)
  })

  it.each([{ code_verifier: 'b'.repeat(43) }, { code_verifier: 'short' }, { redirect_uri: 'https://evil.example/callback' },
    { resource: 'https://evil.example/api/mcp' }, { client_id: 'unknown' }])('does not consume a code for invalid exchange: %j', async overrides => {
    const f = setup()
    const client = await f.register()
    const code = await f.authorize(client)
    expect((await f.exchange(client, code, overrides)).status).toBeGreaterThanOrEqual(400)
    expect((await f.exchange(client, code)).status).toBe(200)
  })

  it('rotates refresh tokens and revokes the family if an old token is replayed', async () => {
    const f = setup()
    const first = await f.connected()
    const response = await f.refresh(first.client, first.refresh_token)
    expect(response.status).toBe(200)
    const second = await response.json()
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect(await f.oauth.authenticate(f.bearer(second.access_token))).toBe(true)
    expect((await f.refresh(first.client, first.refresh_token)).status).toBe(400)
    expect(await f.oauth.authenticate(f.bearer(second.access_token))).toBe(false)
    expect((await f.refresh(first.client, second.refresh_token)).status).toBe(400)
  })

  it.each(['code', 'refresh'])('elects one winner across concurrent %s exchanges', async type => {
    const f = setup()
    const client = await f.register()
    const code = await f.authorize(client)
    let refreshToken = ''
    if (type === 'refresh') refreshToken = (await (await f.exchange(client, code)).json()).refresh_token
    const responses = await Promise.all(Array.from({ length: 3 }, () => type === 'code' ? f.exchange(client, code) : f.refresh(client, refreshToken)))
    expect(responses.map(r => r.status).sort()).toEqual([200, 400, 400])
    const tokens = await responses.find(r => r.status === 200)!.json()
    expect(await f.oauth.authenticate(f.bearer(tokens.access_token))).toBe(false)
  })

  it('narrows editor scopes on refresh without permitting expansion later', async () => {
    const f = setup({ access: 'editor' })
    const tokens = await f.connected({ scope: 'mcp:read mcp:write' })
    const req = f.bearer(tokens.access_token)
    expect(await f.oauth.authenticate(req)).toBe(true)
    expect(req.user).toMatchObject({ _mcpKey: { scopes: { preset: 'editor' } } })
    const narrowed = await (await f.refresh(tokens.client, tokens.refresh_token, { scope: 'mcp:read' })).json()
    expect((await f.refresh(tokens.client, narrowed.refresh_token, { scope: 'mcp:read mcp:write' })).status).toBe(400)
    expect((await f.refresh(tokens.client, narrowed.refresh_token)).status).toBe(200)
  })

  it('does not allow another registered client to redeem or revoke credentials', async () => {
    const f = setup()
    const tokens = await f.connected()
    const second = await f.register('https://claude.com/api/mcp/auth_callback')
    expect((await f.refresh(second, tokens.refresh_token)).status).toBe(400)
    expect((await f.call('/revoke', 'POST', new URLSearchParams({ client_id: second, token: tokens.access_token }).toString(), null)).status).toBe(200)
    expect(await f.oauth.authenticate(f.bearer(tokens.access_token))).toBe(true)
  })

  it('revokes all credentials for a grant and hides unknown-token existence', async () => {
    const f = setup()
    const tokens = await f.connected()
    for (const token of ['unknown', tokens.access_token]) {
      expect((await f.call('/revoke', 'POST', new URLSearchParams({ client_id: tokens.client, token }).toString(), null)).status).toBe(200)
    }
    expect(await f.oauth.authenticate(f.bearer(tokens.access_token))).toBe(false)
    expect((await f.refresh(tokens.client, tokens.refresh_token)).status).toBe(400)
  })

  it('lets the owner disconnect after site permission is removed', async () => {
    const f = setup()
    const tokens = await f.connected()
    f.canAuthorize.mockReturnValue(false)
    const response = await f.call('/connections', 'GET', undefined, account, { accept: 'application/json' })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.eligible).toBe(false)
    const approval = body.grants[0].consent
    expect((await f.call('/connections', 'POST', new URLSearchParams({ consent: approval }).toString(), { ...account, id: 8 })).status).toBe(403)
    expect((await f.call('/connections', 'POST', new URLSearchParams({ consent: approval }).toString())).status).toBe(303)
    expect(await f.oauth.authenticate(f.bearer(tokens.access_token))).toBe(false)
  })

  it.each(['deleted', 'unverified', 'locked', 'policy'])('rechecks current user status at refresh and access: %s', async status => {
    const f = setup()
    const tokens = await f.connected()
    if (status === 'deleted') f.users.delete(String(account.id))
    if (status === 'unverified') f.users.get(String(account.id))!._verified = false
    if (status === 'locked') f.users.get(String(account.id))!.lockUntil = new Date(Date.now() + 60_000).toISOString()
    if (status === 'policy') f.users.get(String(account.id))!.role = 'member'
    expect(await f.oauth.authenticate(f.bearer(tokens.access_token))).toBe(false)
    expect((await f.refresh(tokens.client, tokens.refresh_token)).status).toBe(400)
  })

  it.each(['expired', 'wrong-resource', 'wrong-kind', 'expired-grant'])('refuses invalid access records: %s', async condition => {
    const f = setup()
    const tokens = await f.connected()
    const access = f.records.get(tokenKey(f.payload, tokens.access_token))!
    if (condition === 'expired') access.expiresAt = new Date(0).toISOString()
    if (condition === 'wrong-resource') access.data.resource = 'https://other.example/api/mcp'
    if (condition === 'wrong-kind') access.kind = 'refresh'
    if (condition === 'expired-grant') f.records.get(String(access.data.grant))!.expiresAt = new Date(0).toISOString()
    expect(await f.oauth.authenticate(f.bearer(tokens.access_token))).toBe(false)
  })

  it('does not mutate cookie identity or accept an API key as an OAuth token', async () => {
    const f = setup()
    const req = f.request('')
    expect(await f.oauth.authenticate(req)).toBe(false)
    expect(req.user).toEqual(account)
    expect(await f.oauth.authenticate(f.bearer('ordinary-api-key'))).toBe(false)
    expect(f.find).not.toHaveBeenCalled()
  })

  it('fails closed on authentication storage failures without logging token secrets', async () => {
    const f = setup()
    const tokens = await f.connected()
    f.find.mockRejectedValueOnce(new Error(`database failure ${tokens.access_token}`))
    const req = f.bearer(tokens.access_token)
    expect(await f.oauth.authenticate(req)).toBe(false)
    expect(req.user).toBeNull()
    expect(JSON.stringify(vi.mocked(f.payload.logger.error).mock.calls)).not.toContain(tokens.access_token)
  })

  it('fails closed if the authorization policy throws after identity lookup', async () => {
    const f = setup()
    const tokens = await f.connected()
    f.canAuthorize.mockImplementation(() => { throw new Error('policy dependency unavailable') })
    expect(await f.oauth.authenticate(f.bearer(tokens.access_token))).toBe(false)
    expect((await f.refresh(tokens.client, tokens.refresh_token)).status).toBe(500)
    const connections = await f.call('/connections', 'GET', undefined, account, { accept: 'application/json' })
    expect(connections.status).toBe(200)
    expect((await connections.json()).eligible).toBe(false)
  })

  it('reports persistence failure instead of issuing credentials', async () => {
    const f = setup()
    const client = await f.register()
    const code = await f.authorize(client)
    f.create.mockRejectedValueOnce(new Error('storage offline'))
    const response = await f.exchange(client, code)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'server_error' })
    expect([...f.records.values()].filter(r => r.kind === 'access')).toHaveLength(0)
  })
})

describe('OAuth record consumption and private storage', () => {
  const record: OAuthRecord = { id: 1, key: 'record-hash', kind: 'code', expiresAt: new Date(Date.now() + 60_000).toISOString(), data: {} }

  it('uses a unique claim and returns false for a confirmed duplicate', async () => {
    const f = setup()
    expect(await consumeRecord(f.payload, record)).toBe(true)
    expect(await consumeRecord(f.payload, record)).toBe(false)
    expect(f.records.get(`used:${record.key}`)).toMatchObject({ kind: 'used', expiresAt: record.expiresAt })
  })

  it('propagates an unrelated insert failure when no claim exists', async () => {
    const f = setup()
    const error = new Error('database disconnected')
    f.create.mockRejectedValueOnce(error)
    await expect(consumeRecord(f.payload, record)).rejects.toBe(error)
  })

  it('does not mistake an unrelated insert error for a duplicate when a stale claim already exists', async () => {
    const f = setup()
    await consumeRecord(f.payload, record)
    const error = new Error('database disconnected')
    f.create.mockRejectedValueOnce(error)
    await expect(consumeRecord(f.payload, record)).rejects.toBe(error)
  })

  it('fails closed when confirming a failed insert also fails', async () => {
    const f = setup()
    f.create.mockRejectedValueOnce(duplicateError())
    const error = new Error('lookup disconnected')
    f.find.mockRejectedValueOnce(error)
    await expect(consumeRecord(f.payload, record)).rejects.toBe(error)
  })

  it.each([['other-collection', 'key'], [OAUTH_COLLECTION, 'data']])('does not recover an error for another collection or field: %s %s', async (collection, path) => {
    const f = setup()
    await consumeRecord(f.payload, record)
    const error = duplicateError(collection, path)
    f.create.mockRejectedValueOnce(error)
    await expect(consumeRecord(f.payload, record)).rejects.toBe(error)
    expect(f.find).not.toHaveBeenCalled()
  })

  it('propagates a matching uniqueness error if no committed claim exists', async () => {
    const f = setup()
    const error = duplicateError()
    f.create.mockRejectedValueOnce(error)
    await expect(consumeRecord(f.payload, record)).rejects.toBe(error)
    expect(f.find).toHaveBeenCalledOnce()
  })

  it('does not expose token records through collection access and declares a database unique key', () => {
    const collection = createOAuthCollection()
    expect(collection.slug).toBe(OAUTH_COLLECTION)
    expect(collection.fields).toContainEqual({ name: 'key', type: 'text', required: true, unique: true })
    for (const operation of ['create', 'read', 'update', 'delete'] as const) expect(collection.access![operation]!({} as never)).toBe(false)
  })
})

describe('OAuth consent permissions', () => {
  async function approve(f: ReturnType<typeof setup>, permissions?: unknown) {
    const client = await f.register()
    const approval = await f.consent(client, { scope: 'mcp:read mcp:write' })
    const body = new URLSearchParams({ consent: approval, decision: 'allow',
      ...(permissions === undefined ? {} : { permissions: typeof permissions === 'string' ? permissions : JSON.stringify(permissions) }) })
    return { client, approval, response: await f.call('/authorize', 'POST', body.toString()) }
  }
  async function tokensFor(f: ReturnType<typeof setup>, permissions?: unknown) {
    const { client, response } = await approve(f, permissions)
    expect(response.status).toBe(303)
    const code = new URL(response.headers.get('location')!).searchParams.get('code')!
    return (await f.exchange(client, code)).json()
  }
  async function scopesFor(f: ReturnType<typeof setup>, token: string) {
    const req = f.bearer(token)
    expect(await f.oauth.authenticate(req)).toBe(true)
    return (req.user as any)._mcpKey.scopes
  }

  it('offers the catalog on the consent screen and grants everything when nothing is customized', async () => {
    const f = setup({ access: 'editor' })
    const client = await f.register()
    const response = await f.call(`/authorize?${f.authParams(client, { scope: 'mcp:read mcp:write' })}`, 'GET', undefined, account, { accept: 'application/json' })
    expect((await response.json()).catalog).toEqual(catalog)
    const tokens = await tokensFor(f)
    expect(tokens.scope).toBe('mcp:read mcp:write')
    expect(await scopesFor(f, tokens.access_token)).toEqual({ preset: 'editor' })
  })

  it('stores the picked collections, globals and tools and applies them on every request', async () => {
    const f = setup({ access: 'editor' })
    const tokens = await tokensFor(f, { level: 'editor', collections: { posts: ['read', 'update', 'delete'] }, globals: {}, tools: ['findDocument', 'updateDocument', 'deleteDocument'] })
    expect(await scopesFor(f, tokens.access_token)).toEqual({
      preset: 'editor', collections: { posts: ['read', 'update'] }, globals: {}, tools: { allow: ['findDocument', 'updateDocument'] },
    })
    const listed = await (await f.call('/connections', 'GET', undefined, account, { accept: 'application/json' })).json()
    expect(listed.grants[0].summary).toBe('Read, create and update · 1 of 2 collections · 0 of 1 globals · 2 of 3 tools')
  })

  it('narrows the token scope when the user picks read only', async () => {
    const f = setup({ access: 'editor' })
    const tokens = await tokensFor(f, { level: 'read-only' })
    expect(tokens.scope).toBe('mcp:read')
    expect(await scopesFor(f, tokens.access_token)).toEqual({ preset: 'read-only' })
  })

  it('never grants more than the site allows, whatever the form sends', async () => {
    const f = setup()
    const tokens = await tokensFor(f, { level: 'editor', collections: { posts: ['read', 'create'], secrets: ['read'] }, tools: ['updateDocument', 'findDocument', 'nope'] })
    expect(tokens.scope).toBe('mcp:read')
    expect(await scopesFor(f, tokens.access_token)).toEqual({ preset: 'read-only', collections: { posts: ['read'] }, tools: { allow: ['findDocument'] } })
  })

  it('caps stored write access again when the token is narrowed later', async () => {
    const f = setup({ access: 'editor' })
    const tokens = await tokensFor(f, { level: 'editor', collections: { posts: ['read', 'create', 'update'] } })
    const narrowed = await (await f.refresh(await f.register(), tokens.refresh_token, { scope: 'mcp:read' })).json()
    expect(await scopesFor(f, narrowed.access_token)).toEqual({ preset: 'read-only', collections: { posts: ['read'] } })
  })

  it.each(['not json', '[]', 'null', '"editor"'])('rejects a malformed permissions field without using up the consent: %s', async permissions => {
    const f = setup({ access: 'editor' })
    const { approval, response } = await approve(f, permissions)
    expect(response.status).toBe(400)
    const retry = await f.call('/authorize', 'POST', new URLSearchParams({ consent: approval, decision: 'allow' }).toString())
    expect(retry.status).toBe(303)
  })
})
