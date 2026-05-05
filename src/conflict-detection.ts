import type { CollectionConfig, Plugin } from 'payload'
import { API_KEYS_DEFAULT_SLUG } from './api-keys'

const UPGRADE_HINT =
  'payload-mcp-toolkit v0.4 is the standalone successor to @payloadcms/plugin-mcp. ' +
  'Remove the upstream `mcpPlugin(...)` from your `plugins[]` (and the package from your dependencies) before upgrading. ' +
  'See README "Upgrading from 0.3.x".'

/**
 * Returns true when the supplied plugin reference looks like the upstream
 * `mcpPlugin(...)` invocation (function name, source-string sniff, or wrapped
 * config probing). Heuristic: covers the three common ways the upstream
 * plugin shows up in `plugins[]`.
 */
function looksLikeUpstreamPlugin(plugin: unknown): boolean {
  if (typeof plugin !== 'function') return false
  const fn = plugin as (...args: unknown[]) => unknown
  const fnName = (fn.name ?? '').toString()
  if (fnName === 'mcpPlugin' || fnName === 'withMcp') return true

  const src = fn.toString()
  return /@payloadcms\/plugin-mcp/.test(src) || /payload-mcp-api-keys/.test(src)
}

/**
 * Throws if `@payloadcms/plugin-mcp` is also registered in the host config.
 * Two MCP plugins racing for the same collection slug produces a confusing
 * boot crash inside Payload — this surfaces a clearer migration message.
 */
export function assertNoUpstreamPlugin(plugins: Plugin[] | undefined): void {
  if (!plugins || plugins.length === 0) return
  for (const plugin of plugins) {
    if (looksLikeUpstreamPlugin(plugin)) {
      throw new Error(UPGRADE_HINT)
    }
  }
}

/**
 * Throws if a collection with the api-keys slug is already in
 * `incomingConfig.collections` from another source. Prevents duplicate-slug
 * boot errors and gives the user actionable text.
 */
export function assertNoSlugConflict(
  collections: CollectionConfig[] | undefined,
  apiKeysSlug: string = API_KEYS_DEFAULT_SLUG,
): void {
  if (!collections || collections.length === 0) return
  for (const c of collections) {
    if (c?.slug === apiKeysSlug) {
      throw new Error(
        `payload-mcp-toolkit: a collection with slug "${apiKeysSlug}" is already registered. ` +
          'This is usually the upstream `@payloadcms/plugin-mcp` still being active. ' +
          'Remove it before upgrading to v0.4, or pass a different slug via `apiKeyCollection.slug`.',
      )
    }
  }
}
