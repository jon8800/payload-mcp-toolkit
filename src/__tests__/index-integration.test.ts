import { describe, it, expect } from 'vitest'
import type { Config } from 'payload'
import { contentToolkitPlugin } from '../index'

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

describe('contentToolkitPlugin integration', () => {
  it('appends the api-keys collection and the MCP endpoints additively', () => {
    const cfg = contentToolkitPlugin()(baseConfig())
    const slugs = (cfg.collections ?? []).map((c) => c.slug)
    expect(slugs).toContain('payload-mcp-api-keys')
    expect(slugs).toContain('users')
    expect(slugs).toContain('posts')
    const endpointPaths = (cfg.endpoints ?? []).map((e) => `${e.method.toUpperCase()} ${e.path}`)
    expect(endpointPaths).toEqual(expect.arrayContaining(['POST /mcp', 'GET /mcp']))
  })

  it('attaches the bearer strategy to the user collection without losing existing auth config', () => {
    const cfg = contentToolkitPlugin()(baseConfig())
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
    const out = contentToolkitPlugin()(cfg as never)
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
    const out = contentToolkitPlugin()(cfg as never)
    const admins = (out.collections ?? []).find((c) => c.slug === 'admins') as {
      auth: { strategies?: Array<{ name: string }> }
    }
    expect(admins.auth.strategies?.some((s) => s.name === 'mcp-toolkit-bearer')).toBe(true)
  })

  it('throws when @payloadcms/plugin-mcp appears to also be registered', () => {
    const cfg = baseConfig() as Config
    function mcpPlugin() {}
    ;(cfg as { plugins: unknown[] }).plugins = [mcpPlugin as never]
    expect(() => contentToolkitPlugin()(cfg)).toThrow(/standalone successor/)
  })

  it('throws when an existing collection takes the api-keys slug', () => {
    const cfg = baseConfig() as Config & {
      collections: Array<{ slug: string; fields: unknown[] }>
    }
    cfg.collections.push({ slug: 'payload-mcp-api-keys', fields: [] })
    expect(() => contentToolkitPlugin()(cfg as never)).toThrow(/payload-mcp-api-keys/)
  })

  it('honours a custom apiKeyCollection.slug', () => {
    const cfg = contentToolkitPlugin({ apiKeyCollection: { slug: 'my-keys' } })(baseConfig())
    const slugs = (cfg.collections ?? []).map((c) => c.slug)
    expect(slugs).toContain('my-keys')
    expect(slugs).not.toContain('payload-mcp-api-keys')
  })
})
