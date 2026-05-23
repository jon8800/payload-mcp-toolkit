import { describe, it, expect } from 'vitest'
import { assertNoUpstreamPlugin, assertNoSlugConflict } from '../conflict-detection'

describe('assertNoUpstreamPlugin', () => {
  it('does nothing when plugins list is empty / undefined', () => {
    expect(() => assertNoUpstreamPlugin(undefined)).not.toThrow()
    expect(() => assertNoUpstreamPlugin([])).not.toThrow()
  })

  it('throws when a plugin function is named mcpPlugin', () => {
    function mcpPlugin() {}
    expect(() => assertNoUpstreamPlugin([mcpPlugin as never])).toThrow(/standalone successor/)
  })

  it('throws when a plugin closure references @payloadcms/plugin-mcp', () => {
    const wrapper = function () {
      // simulate the upstream plugin reference inside the closure
      const _u = '@payloadcms/plugin-mcp'
      return _u
    }
    expect(() => assertNoUpstreamPlugin([wrapper as never])).toThrow()
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
