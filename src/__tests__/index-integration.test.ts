import { describe, it, expect } from 'vitest'
import type { Config } from 'payload'
import { mcpToolkitPlugin } from '../index'

function baseConfig(): Config {
  return {
    serverURL: 'https://app.example.com',
    secret: 'test-secret',
    admin: { user: 'users' },
    collections: [
      {
        slug: 'users',
        auth: true,
        fields: [{ name: 'email', type: 'email', required: true }],
      },
      {
        slug: 'posts',
        fields: [
          { name: 'title', type: 'text' },
          { name: 'slug', type: 'text' },
        ],
      },
    ],
    endpoints: [],
  } as never
}

describe('mcpToolkitPlugin integration', () => {
  it('appends the api-keys collection and the MCP endpoints additively', () => {
    const cfg = mcpToolkitPlugin()(baseConfig())
    const slugs = (cfg.collections ?? []).map((c) => c.slug)
    expect(slugs).toContain('payload-mcp-api-keys')
    expect(slugs).toContain('users')
    expect(slugs).toContain('posts')
    const endpointPaths = (cfg.endpoints ?? []).map((e) => `${e.method.toUpperCase()} ${e.path}`)
    expect(endpointPaths).toEqual(expect.arrayContaining(['POST /mcp', 'GET /mcp']))
  })

  it('attaches the bearer strategy to the user collection without losing existing auth config', () => {
    const cfg = mcpToolkitPlugin()(baseConfig())
    const users = (cfg.collections ?? []).find((c) => c.slug === 'users') as {
      auth: { strategies?: Array<{ name: string }> }
    }
    expect(users).toBeDefined()
    const names = users.auth.strategies?.map((s) => s.name) ?? []
    expect(names).toContain('mcp-toolkit-bearer')
  })

  it('preserves existing auth.strategies on the user collection', () => {
    const cfg = baseConfig() as Config & {
      collections: Array<{ slug: string; auth?: unknown; fields: unknown[] }>
    }
    const otherStrategy = { name: 'tenant-shared-strategy', authenticate: async () => ({ user: null }) }
    cfg.collections[0]!.auth = { strategies: [otherStrategy] } as never
    const out = mcpToolkitPlugin()(cfg as never)
    const users = (out.collections ?? []).find((c) => c.slug === 'users') as {
      auth: { strategies: Array<{ name: string }> }
    }
    const names = users.auth.strategies.map((s) => s.name)
    expect(names).toEqual(['tenant-shared-strategy', 'mcp-toolkit-bearer'])
  })

  it('respects a custom user collection slug from incomingConfig.admin.user', () => {
    const cfg = baseConfig() as Config & {
      collections: Array<{ slug: string; auth?: unknown; fields: unknown[] }>
      admin?: { user?: string }
    }
    cfg.admin = { user: 'admins' }
    cfg.collections[0]!.slug = 'admins'
    const out = mcpToolkitPlugin()(cfg as never)
    const admins = (out.collections ?? []).find((c) => c.slug === 'admins') as {
      auth: { strategies?: Array<{ name: string }> }
    }
    expect(admins.auth.strategies?.some((s) => s.name === 'mcp-toolkit-bearer')).toBe(true)
  })

  it('throws when @payloadcms/plugin-mcp appears to also be registered', () => {
    const cfg = baseConfig() as Config
    function mcpPlugin() {}
    ;(cfg as { plugins: unknown[] }).plugins = [mcpPlugin as never]
    expect(() => mcpToolkitPlugin()(cfg)).toThrow(/standalone successor/)
  })

  it('throws when an existing collection takes the api-keys slug', () => {
    const cfg = baseConfig() as Config & {
      collections: Array<{ slug: string; fields: unknown[] }>
    }
    cfg.collections.push({ slug: 'payload-mcp-api-keys', fields: [] })
    expect(() => mcpToolkitPlugin()(cfg as never)).toThrow(/payload-mcp-api-keys/)
  })

  it('honours a custom apiKeyCollection.slug', () => {
    const cfg = mcpToolkitPlugin({ apiKeyCollection: { slug: 'my-keys' } })(baseConfig())
    const slugs = (cfg.collections ?? []).map((c) => c.slug)
    expect(slugs).toContain('my-keys')
    expect(slugs).not.toContain('payload-mcp-api-keys')
  })

  it('a host config with no globals still registers the globalScopes field (matrix shows empty state)', () => {
    const cfg = mcpToolkitPlugin()(baseConfig())
    // The field always renders under Custom; the matrix component reports
    // the absence via its own empty-state copy when availableGlobals is [].
    const apiKeys = (cfg.collections ?? []).find((c) => c.slug === 'payload-mcp-api-keys') as {
      fields: Array<{
        name?: string
        admin?: {
          condition?: (data: unknown) => boolean
          components?: { Field?: { clientProps?: { availableGlobals?: string[] } } }
        }
      }>
    }
    const globalScopes = apiKeys.fields.find((f) => f.name === 'globalScopes')!
    expect(globalScopes.admin?.condition?.({ preset: 'custom' })).toBe(true)
    expect(globalScopes.admin?.condition?.({ preset: 'editor' })).toBe(false)
    expect(globalScopes.admin?.components?.Field?.clientProps?.availableGlobals).toEqual([])
  })

  it('a host config with one plain global makes globalScopes UI render under Custom', () => {
    const cfg = baseConfig() as Config & { globals?: unknown[] }
    cfg.globals = [
      { slug: 'site-settings', fields: [{ name: 'siteName', type: 'text' }] },
    ] as never
    const out = mcpToolkitPlugin()(cfg)
    const apiKeys = (out.collections ?? []).find((c) => c.slug === 'payload-mcp-api-keys') as {
      fields: Array<{
        name?: string
        admin?: {
          condition?: (data: unknown) => boolean
          components?: { Field?: { clientProps?: { availableGlobals?: string[] } } }
        }
      }>
    }
    const globalScopes = apiKeys.fields.find((f) => f.name === 'globalScopes')!
    expect(globalScopes.admin?.condition?.({ preset: 'custom' })).toBe(true)
    expect(globalScopes.admin?.components?.Field?.clientProps?.availableGlobals).toEqual([
      'site-settings',
    ])
  })

  it('excluded globals are filtered out of availableGlobals at registration time', () => {
    const cfg = baseConfig() as Config & { globals?: unknown[] }
    cfg.globals = [
      { slug: 'site-settings', fields: [{ name: 'siteName', type: 'text' }] },
      { slug: 'secret-config', fields: [{ name: 'token', type: 'text' }] },
    ] as never
    const out = mcpToolkitPlugin({ exclude: { globals: ['secret-config'] } })(cfg)
    const apiKeys = (out.collections ?? []).find((c) => c.slug === 'payload-mcp-api-keys') as {
      fields: Array<{
        name?: string
        admin?: { components?: { Field?: { clientProps?: { availableGlobals?: string[] } } } }
      }>
    }
    const globalScopes = apiKeys.fields.find((f) => f.name === 'globalScopes')!
    expect(globalScopes.admin?.components?.Field?.clientProps?.availableGlobals).toEqual([
      'site-settings',
    ])
  })
})
