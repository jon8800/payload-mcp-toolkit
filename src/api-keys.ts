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
   * Collection slugs offered as options for the `collectionScopes.collection`
   * select. Snapshotted at plugin-init time from the host Payload config;
   * adding a collection requires a dev-server restart for it to surface in
   * the admin UI.
   */
  availableCollections: string[]
  /**
   * Tool names offered as options for the `toolAllow` / `toolDeny` selects.
   * Sourced from the toolkit's registered tools at plugin init.
   */
  availableTools: string[]
}

const ACTION_OPTIONS = [
  { label: 'Read', value: 'read' },
  { label: 'Create', value: 'create' },
  { label: 'Update', value: 'update' },
  { label: 'Delete', value: 'delete' },
] as const

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
 * Adds the v0.4+ surface on top:
 *   - `preset`: role preset (read-only/editor/admin/custom)
 *   - `collectionScopes`: array of per-collection action overrides (custom only)
 *   - `toolAllow` / `toolDeny`: per-tool whitelist / blacklist
 *   - `expiresAt`, `revokedAt`, `lastUsedAt`: lifecycle fields
 *   - `keyPrefix`: human-readable key id surfaced in audit logs
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
  const collectionOptions = options.availableCollections.map((s) => ({ label: s, value: s }))
  const toolOptions = options.availableTools.map((t) => ({ label: t, value: t }))

  const presetField: Field = {
    name: 'preset',
    type: 'select',
    required: true,
    defaultValue: 'custom',
    options: PRESET_OPTIONS as unknown as { label: string; value: string }[],
    admin: {
      description:
        'Role preset. "Custom" unlocks the per-collection and per-tool override fields below.',
    },
  }

  const collectionScopesField: Field = {
    name: 'collectionScopes',
    type: 'array',
    admin: {
      condition: isCustomPreset,
      description:
        'Per-collection action overrides. Only honoured when preset is "Custom". An empty actions list denies all actions on that collection.',
    },
    fields: [
      {
        name: 'collection',
        type: 'select',
        required: true,
        options: collectionOptions,
        admin: { description: 'Target collection slug.' },
      },
      {
        name: 'actions',
        type: 'select',
        hasMany: true,
        required: true,
        options: ACTION_OPTIONS as unknown as { label: string; value: string }[],
        admin: { description: 'Allowed actions on this collection.' },
      },
    ],
  }

  const toolAllowField: Field = {
    name: 'toolAllow',
    type: 'select',
    hasMany: true,
    options: toolOptions,
    admin: {
      condition: isCustomPreset,
      description:
        'If set, only these tools are callable with this key. Layered on top of preset / collection scopes.',
    },
  }

  const toolDenyField: Field = {
    name: 'toolDeny',
    type: 'select',
    hasMany: true,
    options: toolOptions,
    admin: {
      description:
        'These tools are blocked regardless of preset. Applies on top of any preset.',
    },
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
      {
        name: 'user',
        type: 'relationship',
        relationTo: options.userCollection,
        required: true,
        admin: {
          description:
            'The user this key authenticates as. Tool calls use this user for access checks on target collections.',
        },
      },
      presetField,
      collectionScopesField,
      toolAllowField,
      toolDenyField,
      {
        name: 'keyPrefix',
        type: 'text',
        index: true,
        admin: {
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
          description: 'Optional expiry. Requests authenticated with an expired key are rejected.',
        },
      },
      {
        name: 'revokedAt',
        type: 'date',
        admin: {
          description: 'Set to revoke a key. Revoked keys are rejected at auth time.',
        },
      },
      {
        name: 'lastUsedAt',
        type: 'date',
        admin: {
          readOnly: true,
          description: 'Updated on each successful authentication. Fire-and-forget; not on the request hot path.',
        },
      },
    ],
  }
}
