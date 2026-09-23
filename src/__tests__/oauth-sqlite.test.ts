import { createHash } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { buildConfig, getPayload, type Payload, type PayloadRequest } from 'payload'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { createOAuth } from '../oauth'
import { createOAuthCollection, consumeRecord, readRecord, tokenKey, writeRecord } from '../oauth-store'

let payload: Payload
const origin = 'https://cms.example.com'
const callback = 'https://claude.ai/api/mcp/auth_callback'
const resource = `${origin}/api/mcp`
let user: PayloadRequest['user']
const config = { serverURL: origin, collections: [{ slug: 'users', auth: true, fields: [] }] }
const oauth = createOAuth({ canAuthorize: () => true, access: 'editor' }, config, 'users')

async function call(path: string, body?: URLSearchParams | object, asUser = false) {
  const method = body ? 'post' : 'get'
  const url = new URL(`${origin}/api/mcp/oauth/${path}`)
  const request = new Request(url, { method: method.toUpperCase(), headers: body ? {
    'Content-Type': body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json', origin,
  } : { accept: 'application/json' }, body: body ? (body instanceof URLSearchParams ? body.toString() : JSON.stringify(body)) : undefined })
  Object.assign(request, { payload, user: asUser ? user : null })
  const endpoint = oauth.endpoints.find(e => e.path === url.pathname.slice(4) && e.method === method)!
  return endpoint.handler(request as PayloadRequest)
}

beforeAll(async () => {
  payload = await getPayload({ config: buildConfig({ ...config, secret: 'isolated-oauth-integration-secret',
    db: sqliteAdapter({ client: { url: 'file::memory:' }, push: true }),
    collections: [...config.collections, createOAuthCollection()], typescript: { autoGenerate: false },
  }) })
  const created = await payload.create({ collection: 'users', data: { email: 'oauth@example.com', password: 'integration-password-1!' } })
  user = { ...created, collection: 'users' }
})

afterAll(async () => {
  await payload?.destroy()
  ;(payload?.db as unknown as { client?: { close: () => void } })?.client?.close()
})

it('uses the real database for one-use codes, refresh, revocation and REST isolation', async () => {
  const registration = await call('register', { redirect_uris: [callback] })
  expect(registration.status).toBe(201)
  const { client_id } = await registration.json()
  const verifier = 'a'.repeat(43)
  const params = new URLSearchParams({ client_id, redirect_uri: callback, resource, response_type: 'code',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: 'mcp:read mcp:write', state: 'test-state' })
  const consentPage = await call(`authorize?${params}`, undefined, true)
  expect(consentPage.status).toBe(200)
  const { consent } = await consentPage.json()
  const approval = await call('authorize', new URLSearchParams({ consent, decision: 'allow' }), true)
  expect(approval.status).toBe(303)
  const redirect = new URL(approval.headers.get('location')!)
  expect(redirect.searchParams.get('state')).toBe('test-state')
  const code = redirect.searchParams.get('code')!
  const exchange = new URLSearchParams({ client_id, resource, grant_type: 'authorization_code', code, redirect_uri: callback, code_verifier: verifier })
  const tokenResponse = await call('token', exchange)
  expect(tokenResponse.status).toBe(200)
  const tokens = await tokenResponse.json()
  const headers = new Headers({ authorization: `Bearer ${tokens.access_token}` })
  const request = Object.assign(new Request(resource, { headers }), { payload, user: null }) as unknown as PayloadRequest
  expect(await oauth.authenticate(request)).toBe(true)
  expect(request.user?.id).toBe(user!.id)
  expect((await payload.auth({ headers })).user).toBeNull()
  const stored = await payload.find({ collection: 'payload-mcp-oauth', limit: 100, overrideAccess: true })
  expect(JSON.stringify(stored)).not.toContain(tokens.access_token)
  expect(JSON.stringify(stored)).not.toContain(tokens.refresh_token)
  expect(JSON.stringify(stored)).not.toContain(code)
  await expect(payload.find({ collection: 'payload-mcp-oauth', overrideAccess: false, user })).rejects.toThrow()
  const refresh = new URLSearchParams({ client_id, resource, grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
  const renewed = await call('token', refresh)
  expect(renewed.status).toBe(200)
  const next = await renewed.json()
  expect(next.refresh_token).not.toBe(tokens.refresh_token)
  expect((await call('token', refresh)).status).toBe(400)
  const nextReq = Object.assign(new Request(resource, { headers: { authorization: `Bearer ${next.access_token}` } }), { payload, user: null }) as unknown as PayloadRequest
  expect(await oauth.authenticate(nextReq)).toBe(false)
})

it('elects one consumption winner using the database unique constraint', async () => {
  const key = tokenKey(payload, 'concurrent-code')
  await writeRecord(payload, { key, kind: 'code', expiresAt: new Date(Date.now() + 60_000).toISOString(), data: {} })
  const record = (await readRecord(payload, key))!
  const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => consumeRecord(payload, record)))
  expect(attempts.filter(r => r.status === 'fulfilled' && r.value === true)).toHaveLength(1)
  expect(await consumeRecord(payload, record)).toBe(false)
})
