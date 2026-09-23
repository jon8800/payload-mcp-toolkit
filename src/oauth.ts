import { createHash, randomBytes } from 'node:crypto'
import type { Config, Endpoint, Payload, PayloadRequest } from 'payload'
import { extractBearerToken, hashKey, verifyHash } from './hash'
import { clampScopes, permissionsFrom, summarize, type Catalog, type Choice, type Level } from './oauth-permissions'
import { consumeRecord, isLive, readRecord, revokeGrant, tokenKey, writeRecord, OAUTH_COLLECTION, type OAuthRecord } from './oauth-store'
import type { KeyScopes } from './types'

const BASE = '/mcp/oauth'
const READ = 'mcp:read'
const WRITE = 'mcp:write'
const ACCESS_SECONDS = 3600
const GRANT_SECONDS = 30 * 24 * 3600
// ChatGPT uses this fixed callback only when the server supports RFC 9207 (`iss` in the authorization response).
const DEFAULT_REDIRECTS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect']

export interface OAuthOptions {
  /** Required site policy. Rechecked at consent, refresh and every MCP request. */
  canAuthorize: (req: PayloadRequest) => boolean | Promise<boolean>
  /** Defaults to Payload admin login. Return a same-origin login URL that returns to returnTo. */
  loginURL?: (returnTo: string) => string
  /** Exact trusted callbacks; defaults to the Claude (web/Desktop) and ChatGPT remote connector callbacks. */
  redirectURIs?: string[]
  /** Read-only by default. Editor enables create/update, still subject to Payload access controls. */
  access?: 'read-only' | 'editor'
}

class OAuthError extends Error {
  constructor(public code: string, public status = 400) { super(code) }
}

const levelOf = (scope: string): Level => scope.split(' ').includes(WRITE) ? 'editor' : 'read-only'
const randomToken = () => randomBytes(32).toString('base64url')
const expires = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' } })
const redirect = (url: string) => new Response(null, { status: 303, headers: { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })

// The consent form carries the permission choice, which grows with the number of collections.
async function parameters(req: PayloadRequest, limit = 16_384): Promise<URLSearchParams> {
  if (!req.text || !req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) throw new OAuthError('invalid_request')
  const text = await req.text()
  if (text.length > limit) throw new OAuthError('invalid_request')
  const params = new URLSearchParams(text)
  for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new OAuthError('invalid_request')
  return params
}

/** `catalog` is what the consent screen offers: exposed collections, globals and registered tools. */
export function createOAuth(options: OAuthOptions, config: Config, userCollection: string, catalog: Catalog) {
  if (typeof options.canAuthorize !== 'function') throw new Error('OAuth requires canAuthorize(req).')
  const origin = new URL(config.serverURL || '')
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new Error('OAuth requires an HTTPS serverURL origin (HTTP loopback is allowed for development).')
  }
  if ((config.routes?.api ?? '/api') !== '/api') throw new Error('OAuth currently requires routes.api = /api.')
  if (!config.collections?.some(c => c.slug === userCollection && c.auth)) throw new Error('OAuth requires an authenticated user collection.')
  const issuer = origin.origin
  const baseURL = `${issuer}/api${BASE}`
  const resource = `${issuer}/api/mcp`
  const metadataURL = `${baseURL}/resource`
  const adminURL = `${issuer}${config.routes?.admin ?? '/admin'}`
  const redirects = options.redirectURIs ?? DEFAULT_REDIRECTS
  if (!redirects.length || redirects.length > 20) throw new Error('OAuth requires 1–20 exact redirectURIs.')
  for (const value of redirects) {
    const url = new URL(value)
    if (url.hash || url.username || url.password || url.searchParams.has('code') || url.searchParams.has('state') ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
      throw new Error('OAuth redirectURIs must be HTTPS URLs or HTTP loopback URLs without fragments or credentials.')
    }
  }
  const supportedScopes = options.access === 'editor' ? [READ, WRITE] : [READ]
  // Registration is limited to operator-trusted callbacks. Stable public IDs need no client table.
  function clients(payload: Payload) {
    return redirects.map(uri => ({ uri, id: `mcp_${hashKey(`oauth-client:${issuer}:${uri}`, payload.secret)}` }))
  }
  function client(req: PayloadRequest, id: string | null) {
    const result = clients(req.payload).find(c => c.id === id)
    if (!result) throw new OAuthError('invalid_client', 401)
    return result
  }
  // Scopes this site does not grant (offline_access, openid, write on a read-only site) are dropped, never granted.
  // RFC 6749 §3.3 lets the server narrow a request, and some clients (ChatGPT) add scopes of their own.
  // Returns '' when nothing supported remains; each caller picks its own fallback.
  function scopes(value: string | null): string {
    return [...new Set(value?.split(' ').filter(s => supportedScopes.includes(s)))].sort().join(' ')
  }
  function signed(payload: Payload, value: Record<string, unknown>): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${body}.${hashKey(`oauth-consent:${body}`, payload.secret)}`
  }
  function verified(payload: Payload, value: string): Record<string, unknown> {
    const [body, signature, extra] = value.split('.')
    if (!body || !signature || extra || !verifyHash(signature, hashKey(`oauth-consent:${body}`, payload.secret))) throw new OAuthError('invalid_request')
    const data = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>
    if (typeof data.expires !== 'number' || data.expires <= Date.now()) throw new OAuthError('invalid_request')
    return data
  }
  async function session(req: PayloadRequest): Promise<boolean> {
    const user = req.user as Record<string, unknown> | null
    if (!user || user.collection !== userCollection || user._mcpKey || req.headers.has('authorization') || user._verified === false ||
      (typeof user.lockUntil === 'string' && Date.parse(user.lockUntil) > Date.now())) return false
    return (await options.canAuthorize(req)) === true
  }
  function login(req: PayloadRequest): Response {
    const requestURL = new URL(req.url!)
    const returnTo = `${requestURL.pathname}${requestURL.search}`
    const url = new URL(options.loginURL?.(returnTo) ?? `${config.routes?.admin ?? '/admin'}/login?redirect=${encodeURIComponent(returnTo)}`, issuer)
    if (url.origin !== issuer) throw new OAuthError('invalid_request')
    return redirect(url.href)
  }
  function csrf(req: PayloadRequest, value: Record<string, unknown>) {
    if (req.headers.get('origin') !== issuer || String(value.user) !== String(req.user?.id)) throw new OAuthError('access_denied', 403)
  }
  async function grantFor(payload: Payload, record: OAuthRecord): Promise<OAuthRecord> {
    const grant = typeof record.data.grant === 'string' ? await readRecord(payload, record.data.grant) : undefined
    if (!isLive(grant) || grant.kind !== 'grant' || grant.data.resource !== resource) throw new OAuthError('invalid_grant')
    return grant
  }
  async function userFor(req: PayloadRequest, grant: OAuthRecord): Promise<PayloadRequest['user']> {
    const id = grant.data.user
    if (typeof id !== 'string' && typeof id !== 'number') throw new OAuthError('invalid_grant')
    const result = await req.payload.find({ collection: userCollection, where: { id: { equals: id } }, limit: 1, depth: 0, overrideAccess: true })
    const user = result.docs[0]
    if (!user || (user._verified === false) || (typeof user.lockUntil === 'string' && Date.parse(user.lockUntil) > Date.now())) throw new OAuthError('invalid_grant')
    const authenticated = { ...user, collection: userCollection } as PayloadRequest['user']
    const policyReq = Object.assign(Object.create(Object.getPrototypeOf(req)), req, { user: authenticated }) as PayloadRequest
    if ((await options.canAuthorize(policyReq)) !== true) throw new OAuthError('invalid_grant')
    return authenticated
  }
  async function issue(req: PayloadRequest, grant: OAuthRecord, scope: string): Promise<Response> {
    const access = `mcp_at_${randomToken()}`
    const refresh = `mcp_rt_${randomToken()}`
    const data = { grant: grant.key, client: grant.data.client, resource, scope }
    await writeRecord(req.payload, { key: tokenKey(req.payload, access), kind: 'access', expiresAt: expires(ACCESS_SECONDS), data })
    await writeRecord(req.payload, { key: tokenKey(req.payload, refresh), kind: 'refresh', expiresAt: grant.expiresAt, data })
    return json({ access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_SECONDS, scope })
  }
  const endpoints: Endpoint[] = []
  function endpoint(path: string, method: Endpoint['method'], handler: (req: PayloadRequest) => Promise<Response> | Response) {
    endpoints.push({ path: `${BASE}${path}`, method, handler: async req => {
      try { return await handler(req) } catch (error) {
        if (error instanceof OAuthError) return json({ error: error.code }, error.status)
        req.payload.logger.error({ event: 'mcp.oauth.failed' }, '[payload-mcp-toolkit] OAuth operation failed')
        return json({ error: 'server_error' }, 500)
      }
    } })
  }
  endpoint('/resource', 'get', () => json({ resource, authorization_servers: [issuer], scopes_supported: supportedScopes, bearer_methods_supported: ['header'] }))
  endpoint('/metadata', 'get', () => json({ issuer, authorization_endpoint: `${baseURL}/authorize`, token_endpoint: `${baseURL}/token`,
    registration_endpoint: `${baseURL}/register`, revocation_endpoint: `${baseURL}/revoke`, response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: supportedScopes,
    authorization_response_iss_parameter_supported: true }))
  endpoint('/register', 'post', async req => {
    if (!req.text || !req.headers.get('content-type')?.startsWith('application/json')) throw new OAuthError('invalid_client_metadata')
    const text = await req.text()
    if (text.length > 4096) throw new OAuthError('invalid_client_metadata')
    let data: Record<string, unknown>
    try { data = JSON.parse(text) } catch { throw new OAuthError('invalid_client_metadata') }
    if (!data || !Array.isArray(data.redirect_uris) || data.redirect_uris.length !== 1 ||
      (data.token_endpoint_auth_method && data.token_endpoint_auth_method !== 'none') ||
      (data.grant_types && (!Array.isArray(data.grant_types) || data.grant_types.some(t => !['authorization_code', 'refresh_token'].includes(t)))) ||
      (data.response_types && (!Array.isArray(data.response_types) || data.response_types.length !== 1 || data.response_types[0] !== 'code'))) throw new OAuthError('invalid_client_metadata')
    const registered = clients(req.payload).find(c => c.uri === (data.redirect_uris as unknown[])[0])
    if (!registered) throw new OAuthError('invalid_redirect_uri')
    return json({ client_id: registered.id, client_name: new URL(registered.uri).hostname, redirect_uris: [registered.uri],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }, 201)
  })
  endpoint('/authorize', 'get', async req => {
    const params = new URL(req.url!).searchParams
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new OAuthError('invalid_request')
    const registered = client(req, params.get('client_id'))
    if (params.get('redirect_uri') !== registered.uri || params.get('response_type') !== 'code' ||
      params.get('resource') !== resource || params.get('code_challenge_method') !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(params.get('code_challenge') ?? '') || (params.get('state')?.length ?? 0) > 2048) throw new OAuthError('invalid_request')
    const scope = scopes(params.get('scope')) || READ
    if (!req.user) return login(req)
    if (!await session(req)) throw new OAuthError('access_denied', 403)
    const consent = signed(req.payload, { user: req.user.id, client: registered.id, redirect: registered.uri,
      challenge: params.get('code_challenge'), state: params.get('state'), scope, resource, expires: Date.now() + 600_000, nonce: randomToken() })
    if (!req.headers.get('accept')?.includes('application/json')) return redirect(`${adminURL}/mcp-authorize?${params}`)
    return json({ consent, clientName: new URL(registered.uri).hostname, account: String(req.user.email ?? req.user.id), scope, catalog })
  })
  endpoint('/authorize', 'post', async req => {
    if (!await session(req)) throw new OAuthError('access_denied', 403)
    const params = await parameters(req, 131_072)
    const consent = verified(req.payload, params.get('consent') ?? '')
    csrf(req, consent)
    const registered = client(req, String(consent.client))
    if (consent.redirect !== registered.uri || consent.resource !== resource) throw new OAuthError('invalid_request')
    const callback = new URL(registered.uri)
    if (typeof consent.state === 'string') callback.searchParams.set('state', consent.state)
    callback.searchParams.set('iss', issuer)
    if (params.get('decision') === 'deny') { callback.searchParams.set('error', 'access_denied'); return redirect(callback.href) }
    if (params.get('decision') !== 'allow') throw new OAuthError('invalid_request')
    // The consent screen submits what the user picked; without it the grant gets everything the request allows.
    let choice: Choice = { level: 'editor' }
    const picked = params.get('permissions')
    if (picked !== null) {
      try { choice = JSON.parse(picked) } catch { throw new OAuthError('invalid_request') }
      if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new OAuthError('invalid_request')
    }
    const { level, permissions } = permissionsFrom(choice, catalog, levelOf(scopes(String(consent.scope)) || READ))
    const scope = level === 'editor' ? `${READ} ${WRITE}` : READ
    const used: OAuthRecord = { id: '', key: tokenKey(req.payload, String(consent.nonce)), kind: 'code', expiresAt: new Date(Number(consent.expires)).toISOString(), data: {} }
    if (!await consumeRecord(req.payload, used)) throw new OAuthError('invalid_request')
    const grant = { key: `grant:${randomToken()}`, kind: 'grant' as const, expiresAt: expires(GRANT_SECONDS), owner: String(req.user!.id),
      data: { user: req.user!.id, client: registered.id, redirect: registered.uri, resource, scope, permissions } }
    await writeRecord(req.payload, grant)
    const code = randomToken()
    await writeRecord(req.payload, { key: tokenKey(req.payload, code), kind: 'code', expiresAt: expires(300),
      data: { grant: grant.key, client: registered.id, redirect: registered.uri, challenge: consent.challenge, resource, scope } })
    callback.searchParams.set('code', code)
    return redirect(callback.href)
  })
  endpoint('/token', 'post', async req => {
    const params = await parameters(req)
    const registered = client(req, params.get('client_id'))
    if (req.headers.has('authorization') || params.has('client_secret')) throw new OAuthError('invalid_client', 401)
    const type = params.get('grant_type')
    if (type !== 'authorization_code' && type !== 'refresh_token') throw new OAuthError('unsupported_grant_type')
    // RFC 8707 makes `resource` optional here (some clients omit it on refresh); codes and refresh tokens are already bound to it.
    if (params.has('resource') && params.get('resource') !== resource) throw new OAuthError('invalid_target')
    const raw = params.get(type === 'authorization_code' ? 'code' : 'refresh_token') ?? ''
    const record = await readRecord(req.payload, tokenKey(req.payload, raw))
    if (!isLive(record) || record.kind !== (type === 'authorization_code' ? 'code' : 'refresh') || record.data.client !== registered.id || record.data.resource !== resource) throw new OAuthError('invalid_grant')
    const grant = await grantFor(req.payload, record)
    await userFor(req, grant)
    if (type === 'authorization_code') {
      const verifier = params.get('code_verifier') ?? ''
      if (params.get('redirect_uri') !== record.data.redirect || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        createHash('sha256').update(verifier).digest('base64url') !== record.data.challenge) throw new OAuthError('invalid_grant')
    }
    // A scope list with nothing this site grants counts as omitted (RFC 6749 §6), so it keeps the stored scope.
    const scope = scopes(params.get('scope')) || String(record.data.scope)
    if (scope.split(' ').some(s => !String(record.data.scope).split(' ').includes(s))) throw new OAuthError('invalid_scope')
    if (!await consumeRecord(req.payload, record)) { await revokeGrant(req.payload, grant); throw new OAuthError('invalid_grant') }
    return issue(req, grant, scope)
  })
  endpoint('/revoke', 'post', async req => {
    const params = await parameters(req)
    const registered = client(req, params.get('client_id'))
    const record = await readRecord(req.payload, tokenKey(req.payload, params.get('token') ?? ''))
    if (record && ['access', 'refresh'].includes(record.kind) && record.data.client === registered.id) {
      const grant = await readRecord(req.payload, String(record.data.grant))
      if (grant?.kind === 'grant') await revokeGrant(req.payload, grant)
    }
    return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  })
  endpoint('/connections', 'get', async req => {
    if (!req.user) return login(req)
    // Revocation remains available even if the site's authorization policy has since removed access.
    if (req.user.collection !== userCollection || req.headers.has('authorization') || (req.user as Record<string, unknown>)._mcpKey) throw new OAuthError('access_denied', 403)
    if (!req.headers.get('accept')?.includes('application/json')) return redirect(`${adminURL}/mcp-connections`)
    const records = await req.payload.find({ collection: OAUTH_COLLECTION, where: { and: [{ kind: { equals: 'grant' } }, { owner: { equals: String(req.user.id) } }, { expiresAt: { greater_than: new Date().toISOString() } }] }, limit: 0, pagination: false, depth: 0, overrideAccess: true })
    const grants = (records.docs as unknown as OAuthRecord[]).filter(g => String(g.data.user) === String(req.user!.id))
    // Setup steps show only to accounts that may connect; a failing policy must not block disconnecting.
    const eligible = await session(req).catch(() => false)
    return json({ resource, access: options.access ?? 'read-only', eligible, grants: grants.map(g => ({
      clientName: new URL(String(g.data.redirect)).hostname, scope: String(g.data.scope),
      // Current level: the site's access setting may have dropped write since consent.
      summary: summarize(g.data.permissions as KeyScopes | undefined, levelOf(scopes(String(g.data.scope))), catalog),
      consent: signed(req.payload, { user: req.user!.id, grant: g.key, expires: Date.now() + 600_000 }),
    })) })
  })
  endpoint('/connections', 'post', async req => {
    if (!req.user || req.user.collection !== userCollection || req.headers.has('authorization') || (req.user as Record<string, unknown>)._mcpKey) throw new OAuthError('access_denied', 403)
    const params = await parameters(req)
    const consent = verified(req.payload, params.get('consent') ?? '')
    csrf(req, consent)
    const grant = await readRecord(req.payload, String(consent.grant))
    if (!grant || grant.kind !== 'grant' || String(grant.data.user) !== String(req.user.id)) throw new OAuthError('access_denied', 403)
    await revokeGrant(req.payload, grant)
    return redirect(`${baseURL}/connections`)
  })

  async function authenticate(req: PayloadRequest): Promise<boolean> {
    const token = extractBearerToken(req.headers.get('authorization'))
    if (!token?.startsWith('mcp_at_')) return false
    try {
      const record = await readRecord(req.payload, tokenKey(req.payload, token))
      if (!isLive(record) || record.kind !== 'access' || record.data.resource !== resource) return false
      const grant = await grantFor(req.payload, record)
      const user = await userFor(req, grant)
      const scope = scopes(String(record.data.scope))
      if (!scope) return false
      // Grants store what the user picked at consent; older grants have no list and get the whole level.
      const stored = grant.data.permissions as KeyScopes | undefined
      req.user = { ...user, _strategy: 'mcp-toolkit-oauth', _mcpKey: { keyId: grant.id, keyPrefix: null,
        scopes: stored ? clampScopes(stored, levelOf(scope)) : { preset: levelOf(scope) } } } as PayloadRequest['user']
      return true
    } catch (error) {
      if (!(error instanceof OAuthError)) req.payload.logger.error({ event: 'mcp.oauth.authentication_failed' }, '[payload-mcp-toolkit] OAuth authentication failed')
      return false
    }
  }
  // Clients request the challenge scope first, so it must include write when the site allows it.
  return { endpoints, authenticate, metadataURL, scope: supportedScopes.join(' ') }
}
