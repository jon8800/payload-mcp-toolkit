import type { CollectionConfig, Field } from 'payload'

export const API_KEYS_DEFAULT_SLUG = 'payload-mcp-api-keys'

export interface CreateApiKeysCollectionOptions {
  /**
   * Collection slug. Defaults to `payload-mcp-api-keys` for zero-touch
   * compatibility with rows created by `@payloadcms/plugin-mcp` v0.3.x.
   */
  slug?: string
  /**
   * Slug of the user collection that API keys link to. Required.
   */
  userCollection: string
  /**
   * Collection slugs offered to the collection-scopes matrix component.
   * Snapshotted at plugin-init time from the host Payload config; adding a
   * collection requires a dev-server restart for it to surface in the
   * admin UI.
   */
  availableCollections: string[]
  /**
   * Tool names offered as options for the `toolAllow` / `toolDeny` selects.
   * Sourced from the toolkit's registered tools at plugin init.
   */
  availableTools: string[]
}

const PRESET_OPTIONS = [
  { label: 'Read-only', value: 'read-only' },
  { label: 'Editor (read + create + update)', value: 'editor' },
  { label: 'Admin (all actions)', value: 'admin' },
  { label: 'Custom (use overrides below)', value: 'custom' },
] as const

const isCustomPreset = (data: unknown): boolean =>
  !!data && typeof data === 'object' && (data as { preset?: unknown }).preset === 'custom'

/**
 * Builds the `payload-mcp-api-keys` collection used by the v0.4 standalone
 * plugin. Reuses Payload's built-in `useAPIKey: true` so the underlying
 * `apiKey` / `apiKeyIndex` columns match what `@payloadcms/plugin-mcp`
 * v0.3.x wrote — existing rows authenticate without re-issue.
 *
 * Layout:
 *   - Main column: name, description, preset, scopes matrix (custom only),
 *     tools collapsible (custom only).
 *   - Sidebar: user relationship, key prefix, expiresAt, revokedAt,
 *     lastUsedAt — identity + lifecycle metadata kept out of the
 *     scope-editing flow.
 */
export function createApiKeysCollection(
  options: CreateApiKeysCollectionOptions,
): CollectionConfig {
  if (!options || !options.userCollection) {
    throw new Error(
      'createApiKeysCollection: `userCollection` is required (slug of the user collection that owns API keys).',
    )
  }
  if (!Array.isArray(options.availableCollections)) {
    throw new Error(
      'createApiKeysCollection: `availableCollections` is required (slugs of collections that scope overrides may target).',
    )
  }
  if (!Array.isArray(options.availableTools)) {
    throw new Error(
      'createApiKeysCollection: `availableTools` is required (names of registered MCP tools).',
    )
  }

  const slug = options.slug ?? API_KEYS_DEFAULT_SLUG
  const toolOptions = options.availableTools.map((t) => ({ label: t, value: t }))

  const presetField: Field = {
    name: 'preset',
    type: 'select',
    required: true,
    defaultValue: 'custom',
    options: PRESET_OPTIONS as unknown as { label: string; value: string }[],
    admin: {
      description:
        'Role preset. "Custom" unlocks the per-collection matrix and the tool overrides below.',
    },
  }

  // Stored shape: Array<{ collection: string; actions: ('read'|'create'|'update'|'delete')[] }>
  // The default Payload UI for an `array` would force users to add rows
  // one at a time; the custom matrix component renders all available
  // collections at once with a checkbox grid (rows × actions).
  //
  // `availableCollections` is forwarded via `clientProps` — Payload v3's
  // sanctioned escape hatch for serializable static data that the client
  // component needs at render time.
  const collectionScopesField: Field = {
    name: 'collectionScopes',
    type: 'json',
    admin: {
      condition: isCustomPreset,
      components: {
        Field: {
          path: 'payload-mcp-toolkit/client',
          exportName: 'CollectionScopesMatrix',
          clientProps: {
            availableCollections: options.availableCollections,
          },
        },
      },
    },
  }

  const toolsCollapsible: Field = {
    type: 'collapsible',
    label: 'Tool overrides',
    admin: {
      condition: isCustomPreset,
      description:
        'Per-tool whitelist / blacklist. Layered on top of preset and collection scopes.',
      initCollapsed: true,
    },
    fields: [
      {
        name: 'toolAllow',
        type: 'select',
        hasMany: true,
        options: toolOptions,
        admin: {
          description:
            'If set, only these tools are callable with this key. Leave empty to allow any tool the collection scopes permit.',
        },
      },
      {
        name: 'toolDeny',
        type: 'select',
        hasMany: true,
        options: toolOptions,
        admin: {
          description: 'These tools are blocked regardless of any other scope.',
        },
      },
    ],
  }

  return {
    slug,
    admin: {
      group: 'MCP',
      useAsTitle: 'name',
      description:
        'API keys for MCP clients. Scopes control which collections and tools each key can access.',
      defaultColumns: ['name', 'user', 'keyPrefix', 'preset', 'lastUsedAt', 'expiresAt', 'revokedAt'],
    },
    auth: {
      disableLocalStrategy: true,
      useAPIKey: true,
    },
    labels: {
      plural: 'API Keys',
      singular: 'API Key',
    },
    fields: [
      // Main column.
      {
        name: 'name',
        type: 'text',
        required: true,
        admin: { description: 'Human label for this key (e.g. "Editorial team — Claude Desktop").' },
      },
      {
        name: 'description',
        type: 'textarea',
        admin: { description: 'Optional notes about the purpose of this key.' },
      },
      presetField,
      collectionScopesField,
      toolsCollapsible,

      // Sidebar — identity + lifecycle.
      {
        name: 'user',
        type: 'relationship',
        relationTo: options.userCollection,
        required: true,
        admin: {
          position: 'sidebar',
          description:
            'The user this key authenticates as. Tool calls use this user for access checks on target collections.',
        },
      },
      {
        name: 'keyPrefix',
        type: 'text',
        index: true,
        admin: {
          position: 'sidebar',
          readOnly: true,
          description:
            'First 8 characters of the API key — used in audit logs to identify the key without exposing the full secret.',
        },
        hooks: {
          beforeChange: [
            ({ data, originalDoc, value }) => {
              if (typeof value === 'string' && value.length > 0) return value
              const incomingKey = (data as { apiKey?: unknown } | undefined)?.apiKey
              if (typeof incomingKey === 'string' && incomingKey.length >= 8) {
                return incomingKey.slice(0, 8)
              }
              const existing = (originalDoc as { keyPrefix?: unknown } | undefined)?.keyPrefix
              return typeof existing === 'string' ? existing : undefined
            },
          ],
        },
      },
      {
        name: 'expiresAt',
        type: 'date',
        admin: {
          position: 'sidebar',
          description: 'Optional expiry. Requests authenticated with an expired key are rejected.',
        },
      },
      {
        name: 'revokedAt',
        type: 'date',
        admin: {
          position: 'sidebar',
          description: 'Set to revoke a key. Revoked keys are rejected at auth time.',
        },
      },
      {
        name: 'lastUsedAt',
        type: 'date',
        admin: {
          position: 'sidebar',
          readOnly: true,
          description:
            'Updated on each successful authentication. Fire-and-forget; not on the request hot path.',
        },
      },
    ],
  }
}
