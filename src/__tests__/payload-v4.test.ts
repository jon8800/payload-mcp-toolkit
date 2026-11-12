import { describe, it, expect } from 'vitest'
import { definePlugin, type Config, type Plugin } from 'payload'
import { mcpToolkitPlugin } from '../index.js'
import { assertNoEndpointConflict, assertNoUpstreamPlugin, TOOLKIT_PLUGIN_SLUG } from '../conflict-detection.js'

function hostConfig(plugins: Plugin[] = [], endpoints: Config['endpoints'] = []): Config {
  return {
    serverURL: 'https://app.example.com',
    secret: 'test-secret',
    admin: { user: 'users' },
    collections: [{ slug: 'users', auth: true, fields: [] }],
    endpoints,
    plugins,
  } as never
}

// Payload 4's own MCP plugin registers through definePlugin with this slug and these endpoints.
function upstreamV4(): Plugin {
  return definePlugin({ slug: '@payloadcms/plugin-mcp', order: 10, plugin: ({ config }) => config })()
}
const upstreamEndpoints = [
  { path: '/mcp', method: 'post', handler: () => new Response() },
  { path: '/mcp', method: 'get', handler: () => new Response() },
  { path: '/mcp/oauth/authorize', method: 'get', handler: () => new Response() },
] as NonNullable<Config['endpoints']>

describe('Payload 4: @payloadcms/plugin-mcp next to the toolkit', () => {
  it('detects the upstream plugin by its definePlugin slug, even when minification renamed the function', () => {
    const upstream = upstreamV4()
    Object.defineProperty(upstream, 'name', { value: 'a' })
    expect(() => assertNoUpstreamPlugin([upstream])).toThrow(/also registered/)
    expect(() => mcpToolkitPlugin()(hostConfig([upstream]))).toThrow(/\/api\/mcp/)
  })

  it('refuses to register an endpoint that another plugin already serves', () => {
    expect(() => mcpToolkitPlugin()(hostConfig([], upstreamEndpoints))).toThrow(/POST \/api\/mcp is already registered/)
    expect(() =>
      mcpToolkitPlugin({ oauth: { canAuthorize: () => true } })(hostConfig([], [upstreamEndpoints[2]!])),
    ).toThrow(/GET \/api\/mcp\/oauth\/authorize/)
  })

  it('compares methods case-insensitively and ignores other methods on the same path', () => {
    const get = { path: '/mcp', method: 'get', handler: () => new Response() } as never
    expect(() => assertNoEndpointConflict([get], [{ ...(get as object), method: 'GET' } as never])).toThrow()
    expect(() => assertNoEndpointConflict([get], [{ ...(get as object), method: 'post' } as never])).not.toThrow()
  })

  it('uses admin view keys that differ from the upstream mcpAuthorize view', () => {
    const cfg = mcpToolkitPlugin({ oauth: { canAuthorize: () => true } })(hostConfig()) as Config
    const views = cfg.admin?.components?.views ?? {}
    expect(Object.keys(views)).toEqual(['mcpToolkitAuthorize', 'mcpToolkitConnections'])
    expect(views.mcpToolkitAuthorize?.path).toBe('/mcp-authorize')
  })

  it('registers itself in the plugins map under its own slug', () => {
    expect(mcpToolkitPlugin().slug).toBe(TOOLKIT_PLUGIN_SLUG)
    expect(() => assertNoUpstreamPlugin([mcpToolkitPlugin()])).not.toThrow()
  })

  it('keeps version history and authorship off for key and token storage', () => {
    const cfg = mcpToolkitPlugin({ oauth: { canAuthorize: () => true } })(hostConfig()) as Config
    for (const slug of ['payload-mcp-api-keys', 'payload-mcp-oauth']) {
      const collection = cfg.collections?.find((c) => c.slug === slug)
      expect(collection?.versions).toBe(false)
      expect(collection?.authorship).toBe(false)
    }
    // The host's own user collection keeps whatever it set.
    expect(cfg.collections?.find((c) => c.slug === 'users')?.versions).toBeUndefined()
  })
})
