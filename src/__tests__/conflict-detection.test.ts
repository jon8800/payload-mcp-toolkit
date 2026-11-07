import { describe, it, expect } from 'vitest'
import type { Config, Plugin } from 'payload'
import {
  assertNoUpstreamPlugin,
  assertNoSlugConflict,
  isToolkitPlugin,
  markToolkitPlugin,
} from '../conflict-detection.js'
import { mcpToolkitPlugin } from '../index.js'

describe('assertNoUpstreamPlugin', () => {
  it('does nothing when plugins list is empty / undefined', () => {
    expect(() => assertNoUpstreamPlugin(undefined)).not.toThrow()
    expect(() => assertNoUpstreamPlugin([])).not.toThrow()
  })

  it('throws when a plugin function is named mcpPlugin', () => {
    function mcpPlugin() {}
    expect(() => assertNoUpstreamPlugin([mcpPlugin as never])).toThrow(/standalone successor/)
  })

  it('does not read plugin source text: a function mentioning the upstream package or slug is not flagged', () => {
    const wrapper = function () {
      const _u = '@payloadcms/plugin-mcp payload-mcp-api-keys'
      return _u
    }
    expect(() => assertNoUpstreamPlugin([wrapper as never])).not.toThrow()
  })

  it('skips plugin functions marked as the toolkit, even when named like the upstream plugin', () => {
    function mcpPlugin() {}
    expect(() => assertNoUpstreamPlugin([markToolkitPlugin(mcpPlugin as never)])).not.toThrow()
  })

  it('does not throw on unrelated plugin functions', () => {
    function someOtherPlugin() {
      const _x = 'totally unrelated'
      return _x
    }
    expect(() => assertNoUpstreamPlugin([someOtherPlugin as never])).not.toThrow()
  })
})

describe('assertNoSlugConflict', () => {
  it('does nothing when no collections are present', () => {
    expect(() => assertNoSlugConflict(undefined)).not.toThrow()
    expect(() => assertNoSlugConflict([])).not.toThrow()
  })

  it('throws when the api-keys slug is already taken by another collection', () => {
    expect(() =>
      assertNoSlugConflict([{ slug: 'payload-mcp-api-keys', fields: [] } as never]),
    ).toThrow(/payload-mcp-api-keys/)
  })

  it('respects a custom slug override', () => {
    expect(() =>
      assertNoSlugConflict([{ slug: 'custom-keys', fields: [] } as never], 'custom-keys'),
    ).toThrow(/custom-keys/)
  })

  it('does not throw on unrelated collections', () => {
    expect(() =>
      assertNoSlugConflict([
        { slug: 'posts', fields: [] } as never,
        { slug: 'media', fields: [] } as never,
      ]),
    ).not.toThrow()
  })
})

// Regression: `next build` bundles the toolkit and inlines its helpers (with the
// api-keys slug and the upstream package name) into the plugin function. The
// old check searched each plugin's source text, found its own code and threw.
describe('mcpToolkitPlugin startup check under bundling', () => {
  function hostConfig(plugins: Plugin[], extraCollections: Config['collections'] = []): Config {
    return {
      secret: 'test-secret',
      admin: { user: 'users' },
      collections: [
        { slug: 'users', auth: true, fields: [{ name: 'email', type: 'email' }] },
        ...extraCollections,
      ],
      plugins,
    } as never
  }

  function simulateBundled(plugin: Plugin): Plugin {
    Object.defineProperty(plugin, 'toString', {
      value: () =>
        'e=>{const t="payload-mcp-api-keys";if(n.some(e=>/@payloadcms\/plugin-mcp/.test(e)))throw 0;return e}',
    })
    return plugin
  }

  it('does not flag its own bundled plugin function in plugins[]', () => {
    const plugin = simulateBundled(mcpToolkitPlugin())
    expect(plugin.toString()).toContain('payload-mcp-api-keys')
    const cfg = plugin(hostConfig([plugin])) as Config
    expect(cfg.collections?.some((c) => c.slug === 'payload-mcp-api-keys')).toBe(true)
  })

  it('does not flag a bundled third-party plugin whose source mentions the slug', () => {
    const other = simulateBundled(((c: Config) => c) as Plugin)
    const plugin = mcpToolkitPlugin()
    expect(() => plugin(hostConfig([other, plugin]))).not.toThrow()
  })

  it('recognises a plugin marked by another copy of the package', () => {
    const fromOtherCopy = (() => {}) as unknown as Plugin
    ;(fromOtherCopy as unknown as Record<symbol, unknown>)[Symbol.for('payload-mcp-toolkit.plugin')] = true
    expect(isToolkitPlugin(fromOtherCopy)).toBe(true)
    expect(isToolkitPlugin(mcpToolkitPlugin())).toBe(true)
    expect(isToolkitPlugin((() => {}) as unknown as Plugin)).toBe(false)
  })

  it('still fails fast when the upstream plugin already added the api-keys collection', () => {
    const upstreamRanFirst = hostConfig(
      [mcpToolkitPlugin()],
      [{ slug: 'payload-mcp-api-keys', fields: [] }],
    )
    expect(() => mcpToolkitPlugin()(upstreamRanFirst)).toThrow(/payload-mcp-api-keys/)
  })
})
