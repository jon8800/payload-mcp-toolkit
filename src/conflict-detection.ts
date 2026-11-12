import type { CollectionConfig, Endpoint, Plugin } from 'payload'
import { API_KEYS_DEFAULT_SLUG } from './api-keys.js'

/** Payload 4's `definePlugin` slug for the official MCP plugin. */
export const UPSTREAM_PLUGIN_SLUG = '@payloadcms/plugin-mcp'
/** This toolkit's slug in Payload 4's `plugins` map, for cross-plugin discovery. */
export const TOOLKIT_PLUGIN_SLUG = 'payload-mcp-toolkit'

const UPGRADE_HINT =
  'payload-mcp-toolkit: @payloadcms/plugin-mcp is also registered. ' +
  'Both plugins serve /api/mcp and /api/mcp/oauth/{authorize,register,token}, so one would answer requests meant for the other. ' +
  'Register only one of them in `plugins[]`.'

// Symbol.for, not Symbol(): a bundled copy and an external copy of this
// package must still recognise each other's plugin functions.
const TOOLKIT_PLUGIN = Symbol.for('payload-mcp-toolkit.plugin')

/** Tags a plugin function as this toolkit's own, so the upstream check skips it. */
export function markToolkitPlugin<T extends Plugin>(plugin: T): T {
  Object.defineProperty(plugin, TOOLKIT_PLUGIN, { value: true })
  plugin.slug = TOOLKIT_PLUGIN_SLUG
  return plugin
}

export function isToolkitPlugin(plugin: unknown): boolean {
  return (
    typeof plugin === 'function' &&
    (plugin as { [TOOLKIT_PLUGIN]?: unknown })[TOOLKIT_PLUGIN] === true
  )
}

/**
 * Returns true when the plugin is the upstream `@payloadcms/plugin-mcp`.
 * Payload 4's `definePlugin` gives it a stable `slug`, which survives
 * minification. The function-name check covers an unminified 3.x copy.
 * Never reads function source text: bundlers inline helpers (and the
 * api-keys slug with them) into the toolkit's own plugin function, so a
 * source search matched the toolkit and failed `next build`.
 */
function looksLikeUpstreamPlugin(plugin: unknown): boolean {
  if (typeof plugin !== 'function') return false
  if (isToolkitPlugin(plugin)) return false
  if ((plugin as { slug?: unknown }).slug === UPSTREAM_PLUGIN_SLUG) return true
  const fnName = ((plugin as { name?: unknown }).name ?? '').toString()
  return fnName === 'mcpPlugin' || fnName === 'withMcp'
}

/**
 * Throws if `@payloadcms/plugin-mcp` is also registered in the host config.
 * Both plugins answer on the same endpoint paths, so Payload would silently
 * route every MCP request to whichever registered first.
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
 * Throws if another plugin or the host already registered one of the
 * toolkit's endpoints (same method and path). Payload runs the first match,
 * so a duplicate would silently disable one of them.
 */
export function assertNoEndpointConflict(
  existing: Endpoint[] | undefined,
  added: Endpoint[],
): void {
  if (!existing || existing.length === 0) return
  const taken = new Set(existing.map((e) => `${e.method.toLowerCase()} ${e.path}`))
  for (const endpoint of added) {
    const key = `${endpoint.method.toLowerCase()} ${endpoint.path}`
    if (taken.has(key)) {
      throw new Error(
        `payload-mcp-toolkit: the endpoint ${endpoint.method.toUpperCase()} /api${endpoint.path} is already registered. ` +
          'This is usually @payloadcms/plugin-mcp. Register only one MCP plugin.',
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
