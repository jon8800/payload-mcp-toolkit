import type { CollectionBeforeValidateHook, CollectionConfig, Field } from 'payload'

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
  /**
   * Global slugs offered to the global-scopes matrix component. Optional —
   * direct callers of the factory that pre-date globals support continue
   * to work; sites with no globals get an empty array and the second
   * matrix table is not rendered.
   */
  availableGlobals?: string[]
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
  const availableGlobals = Array.isArray(options.availableGlobals)
    ? options.availableGlobals
    : []

  const presetField: Field = {
    name: 'preset',
    type: 'select',
    required: true,
    defaultValue: 'custom',
    options: PRESET_OPTIONS as unknown as { label: string; value: string }[],
    admin: {
      description:
        'Role preset. "Custom" unlocks the per-collection matrix and the tool overrides below. ' +
        'Switching away from Custom CLEARS every override on save (collectionScopes, globalScopes, ' +
        'toolAllow, toolDeny); switching back to Custom starts from a fresh deny-all baseline, so ' +
        'reconfigure the matrices and tool lists before saving.',
    },
  }

  // Stored shape: Array<{ slug: string; actions: ('read'|'create'|'update'|'delete')[] }>
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

  // Mirrors `collectionScopes` exactly — one additive JSONB column with a
  // default of `'[]'`, default-rendered by `GlobalScopesMatrix`. Hidden
  // under non-custom presets. Stored shape:
  //   Array<{ slug: string; actions: ('read'|'update')[] }>
  // No `availableGlobals.length > 0` gate: `ScopesTable` renders its own
  // empty-state message when zero items are passed, so the field surfaces
  // under Custom regardless of host config, matching the collection variant.
  const globalScopesField: Field = {
    name: 'globalScopes',
    type: 'json',
    admin: {
      condition: isCustomPreset,
      components: {
        Field: {
          path: 'payload-mcp-toolkit/client',
          exportName: 'GlobalScopesMatrix',
          clientProps: {
            availableGlobals,
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
            'If set, only these tools are callable with this key. Leave empty to allow any tool ' +
            'the collection or global scopes permit. Under the Custom preset, an empty list is ' +
            'treated as deny-all ONLY when no collection or global scopes are set (the fresh- ' +
            'Custom-key sentinel); when collection or global scopes are populated, an empty list ' +
            'collapses to "no tool restriction" so the resource scopes alone determine what is ' +
            'callable — to deny every tool while keeping resource scopes, enumerate them in ' +
            'toolDeny instead. Preset-mode keys created via the REST API with an empty list are ' +
            'coerced to "no restriction".',
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
    // Every MCP request authenticates by looking up this column. Payload's
    // `useAPIKey` adds `apiKeyIndex` but does not index it, so each call cost a
    // sequential scan over the whole key table — and the table only grows.
    // Declared here rather than added by hand in a host migration, so Payload's
    // schema builder knows about it and never offers to drop it.
    //
    // Not unique: rows exist with a null `apiKeyIndex` (a key row saved before
    // `enableAPIKey` is ticked), and a unique index would let only one of them
    // exist at a time.
    indexes: [{ fields: ['apiKeyIndex'] }],
    hooks: {
      beforeValidate: [
        (({ data, originalDoc }) => {
          // The override fields (collectionScopes, globalScopes, toolAllow,
          // toolDeny) are conditionally rendered only under the Custom preset
          // (`condition: isCustomPreset`). Under any other preset they are
          // hidden in the admin UI, which means two things:
          //
          //   1. The admin form omits hidden fields from its payload on save,
          //      so `data` only carries the visible fields — we can't
          //      "collapse the empty array we see in `data`" because we never
          //      see it at all. The stale value lives on `originalDoc`.
          //   2. A Custom→Admin switch silently keeps the prior
          //      `toolAllow:[...]` / `collectionScopes:[...]`, and
          //      `composeScopes` then emits a scope gate that rejects calls
          //      the user clearly intended to allow.
          //
          // Fix: when the preset is non-Custom, explicitly write `null` into
          // `data` for every override axis (regardless of what `data` carries
          // or what originalDoc holds). Payload persists nulls, so the stale
          // values are erased on every save. The Custom-preset branch below
          // keeps the explicit-empty-means-deny semantic intact.
          if (!data) return data
          const d = data as Record<string, unknown>
          const orig = (originalDoc ?? {}) as Record<string, unknown>
          const preset = d.preset ?? orig.preset

          // `readField` falls through to originalDoc when `data` omits the
          // key entirely (admin form skipping hidden fields), but honours
          // an explicit null/empty in `data` over originalDoc.
          const readField = (key: string): unknown =>
            key in d ? d[key] : orig[key]
          const isNonEmptyArray = (v: unknown): boolean =>
            Array.isArray(v) && v.length > 0
          // Null, undefined, or `[]` — the three shapes that mean "the user
          // expressed no tool restriction". Anything else (a bare string, a
          // number) is malformed and must reach Payload's validator rather than
          // being silently read as "no restriction".
          const isUnset = (v: unknown): boolean =>
            v === null || v === undefined || (Array.isArray(v) && v.length === 0)

          const OVERRIDE_AXES = [
            'collectionScopes',
            'globalScopes',
            'toolAllow',
            'toolDeny',
          ] as const

          if (preset !== 'custom') {
            for (const axis of OVERRIDE_AXES) d[axis] = null
            return data
          }

          // Custom preset: the Tools collapsible is labelled as an *override*
          // layered on top of collection / global scopes, and its description
          // says "Leave empty to allow any tool the collection scopes permit."
          // Payload's hasMany-select default of `[]` would otherwise turn the
          // Tools section into a mandatory whitelist — a user who configures
          // collection scopes and never opens the collapsible would silently
          // store `toolAllow:[]`, which `composeScopes` honours as deny-all on
          // the tools axis and rejects every call.
          //
          // Resolve the mismatch by coercing a non-populated `toolAllow` to
          // null whenever the key carries any concrete resource scope
          // (collection or global entries). "Non-populated" covers both `[]`
          // (what the admin form sends) and a missing key (what a key created
          // through the Local API sends) — Payload reads an unset hasMany
          // select back as `[]` either way, so without this a scripted key
          // with collection scopes and no tool list would deny every tool.
          // The fresh-Custom-key sentinel in `composeScopes` still covers the
          // "no scopes at all" case (everything null → deny-all), so users who
          // genuinely want deny-all do not regress.
          const hasResourceScope =
            isNonEmptyArray(readField('collectionScopes')) ||
            isNonEmptyArray(readField('globalScopes'))
          if (hasResourceScope && isUnset(readField('toolAllow'))) {
            d.toolAllow = null
          }
          return data
        }) as CollectionBeforeValidateHook,
      ],
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
      globalScopesField,
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
