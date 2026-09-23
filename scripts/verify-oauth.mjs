import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const origin = process.env.MCP_VERIFY_ORIGIN ?? 'http://localhost:3059'
const email = process.env.MCP_VERIFY_EMAIL
const password = process.env.MCP_VERIFY_PASSWORD
assert(email && password, 'Set MCP_VERIFY_EMAIL and MCP_VERIFY_PASSWORD for an isolated test account.')
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname), 'This test is restricted to a local test host.')
const base = `${origin}/api/mcp/oauth`
const resource = `${origin}/api/mcp`
const callback = 'https://claude.ai/api/mcp/auth_callback'
const jsonHeaders = { 'content-type': 'application/json' }
async function post(url, data, headers = {}) {
  return fetch(url, { method: 'POST', redirect: 'manual', headers: {
    'content-type': data instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json', ...headers,
  }, body: data instanceof URLSearchParams ? data.toString() : JSON.stringify(data) })
}
if (process.env.MCP_VERIFY_CREATE_USER === '1') {
  const result = await post(`${origin}/api/users/first-register`, { email, password })
  assert([200, 201].includes(result.status), `First test user creation failed: ${result.status}`)
}
const auth = await post(`${origin}/api/users/login`, { email, password })
assert.equal(auth.status, 200, 'Website sign-in failed')
const cookie = auth.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
assert(cookie, 'Website login did not return a cookie')
const discovery = await fetch(`${origin}/.well-known/oauth-authorization-server`)
assert.equal(discovery.status, 200)
assert.equal((await discovery.json()).issuer, origin)
const challenge = await fetch(resource)
assert.equal(challenge.status, 401)
assert(challenge.headers.get('www-authenticate').includes(`${base}/resource`))
const registration = await post(`${base}/register`, { redirect_uris: [callback], token_endpoint_auth_method: 'none' })
assert.equal(registration.status, 201)
const { client_id } = await registration.json()
const verifier = 'v'.repeat(64)
const query = new URLSearchParams({ client_id, redirect_uri: callback, resource, response_type: 'code',
  code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), scope: 'mcp:read', state: 'local-verification' })
const anonymous = await fetch(`${base}/authorize?${query}`, { redirect: 'manual' })
assert.equal(anonymous.status, 303)
assert(new URL(anonymous.headers.get('location')).pathname.endsWith('/login'))
const browserConsent = await fetch(`${base}/authorize?${query}`, { redirect: 'manual', headers: { cookie, 'sec-fetch-site': 'same-origin' } })
assert.equal(browserConsent.status, 303)
const adminConsent = new URL(browserConsent.headers.get('location'))
assert.equal(adminConsent.origin, origin)
assert(adminConsent.pathname.endsWith('/mcp-authorize'))
assert.deepEqual([...adminConsent.searchParams], [...query])
const adminPage = await fetch(adminConsent, { headers: { cookie, 'sec-fetch-site': 'same-origin' } })
assert.equal(adminPage.status, 200)
assert.equal(adminPage.headers.get('referrer-policy'), 'same-origin', 'Native form posts need same-origin provenance')
assert(adminPage.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"))
const consentPage = await fetch(`${base}/authorize?${query}`, { redirect: 'manual', headers: { cookie, 'sec-fetch-site': 'same-origin', accept: 'application/json' } })
assert.equal(consentPage.status, 200)
assert(consentPage.headers.get('cache-control').includes('no-store'))
const { consent } = await consentPage.json()
const approval = await post(`${base}/authorize`, new URLSearchParams({ consent, decision: 'allow' }), { cookie, origin })
assert.equal(approval.status, 303)
const redirect = new URL(approval.headers.get('location'))
assert.equal(redirect.origin, 'https://claude.ai')
assert.equal(redirect.searchParams.get('state'), 'local-verification')
const exchange = await post(`${base}/token`, new URLSearchParams({ client_id, resource, grant_type: 'authorization_code',
  redirect_uri: callback, code_verifier: verifier, code: redirect.searchParams.get('code') }))
assert.equal(exchange.status, 200)
const tokens = await exchange.json()
const mcp = new Client({ name: 'oauth-local-verification', version: '1.0.0' })
await mcp.connect(new StreamableHTTPClientTransport(new URL(resource), { requestInit: { headers: { authorization: `Bearer ${tokens.access_token}` } } }))
const { tools } = await mcp.listTools()
assert(tools.length > 0)
const result = await mcp.callTool({ name: 'findDocument', arguments: { collection: 'posts', limit: 1 } })
assert(!result.isError, 'Read-only MCP content request failed')
await mcp.close()
const rest = await fetch(`${origin}/api/users/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } })
assert.equal((await rest.json()).user, null)
const refreshed = await post(`${base}/token`, new URLSearchParams({ client_id, resource, grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))
assert.equal(refreshed.status, 200)
const next = await refreshed.json()
const browserConnections = await fetch(`${base}/connections`, { redirect: 'manual', headers: { cookie, 'sec-fetch-site': 'same-origin' } })
assert.equal(browserConnections.status, 303)
const adminConnections = new URL(browserConnections.headers.get('location'))
assert.equal(adminConnections.origin, origin)
assert(adminConnections.pathname.endsWith('/mcp-connections'))
const connections = await fetch(`${base}/connections`, { headers: { cookie, 'sec-fetch-site': 'same-origin', accept: 'application/json' } })
assert.equal(connections.status, 200)
assert(connections.headers.get('cache-control').includes('no-store'))
const connectionData = await connections.json()
assert.equal(connectionData.resource, resource)
assert(connectionData.grants.some(grant => grant.consent && grant.scope === 'mcp:read'))
const revoked = await post(`${base}/revoke`, new URLSearchParams({ client_id, token: next.refresh_token }))
assert.equal(revoked.status, 200)
const denied = await post(resource, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...jsonHeaders, authorization: `Bearer ${next.access_token}`, accept: 'application/json, text/event-stream' })
assert.equal(denied.status, 401)
console.log(`PASS: website login, root discovery, consent, PKCE, SDK initialize, ${tools.length} tools, content read, REST isolation, refresh and revocation.`)
