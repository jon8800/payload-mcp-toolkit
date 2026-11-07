import type { CollectionConfig, Plugin } from 'payload'
import { API_KEYS_DEFAULT_SLUG } from './api-keys.js'

const UPGRADE_HINT =
  'payload-mcp-toolkit v0.4 is the standalone successor to @payloadcms/plugin-mcp. ' +
  'Remove the upstream `mcpPlugin(...)` from your `plugins[]` (and the package from your dependencies) before upgrading. ' +
  'See README "Upgrading from 0.3.x".'

// Symbol.for, not Symbol(): a bundled copy and an external copy of this
// package must still recognise each other's plugin functions.
const TOOLKIT_PLUGIN = Symbol.for('payload-mcp-toolkit.plugin')

/** Tags a plugin function as this toolkit's own, so the upstream check skips it. */
export function markToolkitPlugin<T extends Plugin>(plugin: T): T {
  Object.defineProperty(plugin, TOOLKIT_PLUGIN, { value: true })
  return plugin
}

export function isToolkitPlugin(plugin: unknown): boolean {
  return (
    typeof plugin === 'function' &&
    (plugin as { [TOOLKIT_PLUGIN]?: unknown })[TOOLKIT_PLUGIN] === true
  )
}

/**
 * Returns true when the plugin is the upstream `mcpPlugin` / `withMcp`
 * function itself. Never reads function source text: bundlers inline helpers
 * (and the api-keys slug with them) into the toolkit's own plugin function,
 * so a source search matched the toolkit and failed `next build`. The signal
 * that does not depend on bundling is the built config — an api-keys
 * collection that is already present — which `assertNoSlugConflict` checks.
 */
function looksLikeUpstreamPlugin(plugin: unknown): boolean {
  if (typeof plugin !== 'function') return false
  if (isToolkitPlugin(plugin)) return false
  const fnName = ((plugin as { name?: unknown }).name ?? '').toString()
  return fnName === 'mcpPlugin' || fnName === 'withMcp'
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

/**
 * Throws if a custom tool reuses a built-in tool's name.
 *
 * Registering two tools under one name is silently last-wins inside the MCP
 * SDK, which turns a typo into a built-in tool quietly disappearing from
 * `tools/list`. Fail at boot instead, and name both sides in the message.
 */
export function assertNoToolNameConflict(
  builtIn: Array<{ name: string }>,
  custom: Array<{ name: string }> | undefined,
): void {
  if (!custom || custom.length === 0) return
  const taken = new Set(builtIn.map((t) => t.name))
  const seen = new Set<string>()
  for (const tool of custom) {
    if (taken.has(tool.name)) {
      throw new Error(
        `payload-mcp-toolkit: customTools entry "${tool.name}" reuses a built-in tool name. ` +
          'Rename it — a duplicate name would shadow the built-in tool at registration time.',
      )
    }
    if (seen.has(tool.name)) {
      throw new Error(
        `payload-mcp-toolkit: customTools contains two entries named "${tool.name}". Tool names must be unique.`,
      )
    }
    seen.add(tool.name)
  }
}
