import type { CollectionConfig } from 'payload'

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
}

/**
 * Builds the `payload-mcp-api-keys` collection used by the v0.4 standalone
 * plugin. Reuses Payload's built-in `useAPIKey: true` so the underlying
 * `apiKey` / `apiKeyIndex` columns match what `@payloadcms/plugin-mcp`
 * v0.3.x wrote — existing rows authenticate without re-issue.
 *
 * Adds the v0.4 surface on top:
 *   - `scopes` (json): per-key authorization (preset + collection/tool overrides)
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

  const slug = options.slug ?? API_KEYS_DEFAULT_SLUG

  return {
    slug,
    admin: {
      group: 'MCP',
      useAsTitle: 'name',
      description:
        'API keys for MCP clients. Scopes control which collections and tools each key can access.',
      defaultColumns: ['name', 'user', 'keyPrefix', 'lastUsedAt', 'expiresAt', 'revokedAt'],
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
      {
        name: 'scopes',
        type: 'json',
        admin: {
          description:
            'Per-key authorization. Shape: { preset?: "read-only" | "editor" | "admin", collections?: { [slug]: ("read"|"create"|"update"|"delete")[] }, tools?: { allow?: string[], deny?: string[] } }. Leave unset for full access (back-compat).',
        },
      },
      {
        name: 'keyPrefix',
        type: 'text',
        index: true,
        admin: {
          readOnly: true,
          description: 'First 8 characters of the API key — used in audit logs to identify the key without exposing the full secret.',
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
