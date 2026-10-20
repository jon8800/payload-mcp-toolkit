import { describe, it, expect } from 'vitest'
import { definePlugin, type Config, type Plugin } from 'payload'
import { assertNoUpstreamPlugin, assertNoSlugConflict } from '../conflict-detection'

describe('assertNoUpstreamPlugin', () => {
  it('does nothing when plugins list is empty / undefined', () => {
    expect(() => assertNoUpstreamPlugin(undefined)).not.toThrow()
    expect(() => assertNoUpstreamPlugin([])).not.toThrow()
  })

  it('rejects the upstream v4 definePlugin identity even when the function name changes', () => {
    const upstream = definePlugin({ slug: '@payloadcms/plugin-mcp', order: 10, plugin: ({ config }) => config })()
    Object.defineProperty(upstream, 'name', { value: 'a' })
    upstream.toString = () => { throw new Error('Function source must not identify a plugin') }
    expect(() => assertNoUpstreamPlugin([upstream])).toThrow(/standalone successor/)
  })

  it('allows unrelated plugins that mention the upstream package', () => {
    const wrapper = (config: Config) => ({ ...config, custom: { description: '@payloadcms/plugin-mcp' } })
    expect(() => assertNoUpstreamPlugin([wrapper])).not.toThrow()
  })

  it('allows the toolkit collection literal after production inlining', () => {
    const inlinedToolkit: Plugin = (config) => ({ ...config, collections: [
      ...(config.collections ?? []), { slug: 'payload-mcp-api-keys', fields: [] },
    ] })
    expect(() => assertNoUpstreamPlugin([inlinedToolkit])).not.toThrow()
  })

  it('does not use a function name as package identity', () => {
    function mcpPlugin(config: Config) { return config }
    expect(() => assertNoUpstreamPlugin([mcpPlugin])).not.toThrow()
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
