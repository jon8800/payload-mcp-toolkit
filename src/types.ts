import type { ToolFactoryOutput } from './registry'

/**
 * payload-mcp-toolkit configuration.
 *
 * The plugin works with zero options — every field below is an escape hatch
 * for the cases where Payload's own config doesn't carry enough signal.
 */
export interface ContentToolkitOptions {
  /**
   * Preview URL behavior. The toolkit reads `collection.admin.livePreview.url`
   * (or `collection.admin.preview` as a fallback) when generating preview links
   * for draft documents. Provide this object only to override what Payload
   * already knows.
   */
  preview?: {
    /**
     * Absolute base URL prepended to relative preview paths. Defaults to
     * `incomingConfig.serverURL`, then `process.env.NEXT_PUBLIC_SERVER_URL`,
     * then `process.env.SITE_URL`. If none of those resolve and your preview
     * URL function returns a relative path, no preview URL is appended.
     */
    siteUrl?: string

    /**
     * Disable preview URL injection entirely.
     */
    disabled?: boolean
  }

  /**
   * Per-collection draft behavior overrides. The default behavior is inferred
   * from each collection's `versions.drafts` setting:
   * - drafts enabled  → `'always-draft'` (raw `update` is locked; clients go
   *   through `publishDraft` / `patchLayout` / `updateDocument` which preserve
   *   draft semantics)
   * - drafts disabled → `'always-publish'`
   *
   * Override per slug only if you need to allow raw publish on a draftable
   * collection.
   */
  draftBehavior?: Record<string, 'always-draft' | 'always-publish'>

  /**
   * Override the auth collection used for API key linkage. By default the
   * toolkit scans `incomingConfig.collections` for the first collection with
   * `auth: true`, preferring one named `'users'`.
   */
  userCollection?: string

  /**
   * Hide collections or globals from the MCP surface. Useful for internal
   * bookkeeping collections that should not be exposed to AI clients.
   */
  exclude?: {
    collections?: string[]
    globals?: string[]
  }

  /**
   * Site-specific domain prompts that teach the AI business vocabulary.
   * Merged with the auto-generated prompts.
   */
  domainPrompts?: DomainPrompt[]

  /** Media upload configuration */
  mediaUpload?: {
    /** Maximum file size in bytes (default: 10MB) */
    maxFileSize?: number
    /** Media collection slug (default: 'media') */
    collectionSlug?: string
  }

  /**
   * Extra tools to register alongside the built-in ones.
   *
   * Each entry is a plain `ToolFactoryOutput`: a name, a description, a Zod
   * shape (or `z.object({...})`), a handler, and a `routing` tag. Custom tools
   * go through the same wrapper as the built-ins — scope checks, `req.context
   * .source = 'mcp'` stamping, and the audit log all apply — and their names
   * appear in the API-key scope dropdowns.
   *
   * The handler receives the live `PayloadRequest`, so a tool that needs the
   * authenticated user or the Payload instance reads them off `req` per call
   * rather than closing over them at boot.
   *
   * `routing` decides which scope axis gates the tool. Use
   * `{kind: 'collection', action: 'read'}` for a tool whose args carry a
   * `collection` (or `slug`) key — the registry reads that key to find the
   * target for the scope check.
   *
   * A custom tool may not reuse a built-in tool's name; the plugin throws at
   * boot if one does.
   *
   * ```ts
   * mcpToolkitPlugin({
   *   customTools: [{
   *     name: 'countActiveMembers',
   *     description: 'Number of members with an active membership.',
   *     parameters: { since: z.string().optional() },
   *     routing: { kind: 'collection', action: 'read' },
   *     handler: async (args, req) => {
   *       const { totalDocs } = await req.payload.count({ collection: 'memberships' })
   *       return { content: [{ type: 'text', text: String(totalDocs) }] }
   *     },
   *   }],
   * })
   * ```
   */
  customTools?: ToolFactoryOutput[]

  /**
   * MCP transport / auth configuration. Mostly safe to leave unset;
   * defaults to no-CORS server-to-server use only.
   */
  auth?: {
    /**
     * Origins permitted on the `Origin` header. Empty / unset means
     * server-to-server callers only (no browser-based MCP clients).
     * `*` is intentionally not honoured.
     */
    allowedOrigins?: string[]
  }

  /**
   * Override API-key collection settings. Slug defaults to
   * `payload-mcp-api-keys` for zero-touch upgrade compatibility with
   * `@payloadcms/plugin-mcp` v0.3.x rows.
   */
  apiKeyCollection?: {
    slug?: string
    /**
     * Override the user collection that API keys link to. By default
     * the toolkit reuses the same `userCollection` resolution as elsewhere
     * (`options.userCollection`, then `incomingConfig.admin.user`).
     */
    userCollection?: string
  }
}

/** A domain prompt that teaches the AI site-specific vocabulary */
export interface DomainPrompt {
  /** Unique name for the prompt */
  name: string
  /** Display title */
  title: string
  /** Description of what this prompt teaches */
  description: string
  /** The prompt content */
  content: string
}

/** Introspected field metadata */
export interface FieldSchema {
  name: string
  type: string
  required?: boolean
  hasMany?: boolean
  relationTo?: string | string[]
  options?: Array<{ label: string; value: string }>
  fields?: FieldSchema[]
  maxRows?: number
}

/** Introspected collection metadata */
export interface CollectionSchema {
  slug: string
  fields: FieldSchema[]
  hasDrafts: boolean
  hasLivePreview: boolean
  relationships: Array<{ fieldName: string; relationTo: string | string[]; hasMany: boolean }>
  searchableFields: string[]
}

/** Introspected global metadata. Globals are singletons — no relationships or searchable-fields graph. */
export interface GlobalSchema {
  slug: string
  fields: FieldSchema[]
  hasDrafts: boolean
  hasLivePreview: boolean
}

/**
 * One block in the catalog. Flat — no section/leaf distinction. Whether a
 * block can nest other blocks is encoded in the `BlockNestingMap` keyed by
 * the path to its `blocks` field.
 */
export interface BlockSchema {
  slug: string
  fields: FieldSchema[]
}

/**
 * Flat catalog of every block referenced by the schema.
 */
export interface BlockCatalog {
  blocks: BlockSchema[]
}

/**
 * One entry per `blocks`-typed field anywhere in the schema.
 *
 * `path` is `<owner>.<dottedFieldPath>` where owner is the collection or
 * block slug that contains the field. Values list the slugs that field
 * accepts. The AI uses this to compose blocks at any nesting depth without
 * us pre-classifying anything as a "section" or "leaf".
 */
export interface BlockNestingEdge {
  /** Owner of the blocks field — a collection slug, a block slug, or a global slug. */
  owner: string
  /** Whether the owner is a collection, a block, or a global */
  ownerType: 'collection' | 'block' | 'global'
  /** Dotted path to the blocks field within the owner (e.g. `layout`, `hero.content`) */
  fieldPath: string
  /** Block slugs that this field accepts */
  acceptedBlockSlugs: string[]
  /** Optional row cap from the field config */
  maxRows?: number
}

/** Map of every blocks-field in the schema to the slugs it accepts */
export type BlockNestingMap = BlockNestingEdge[]

/** Relationship edge in the collection graph */
export interface RelationshipEdge {
  fromCollection: string
  fieldName: string
  toCollection: string | string[]
  hasMany: boolean
}

// ─── Scope shapes ─────────────────────────────────────────────────────
//
// Canonical scope types live here so the auth strategy, registry, and admin
// API-keys collection all import from the same surface. Globals support
// only `read` / `update` — they don't have `create` / `delete` semantics.

export type CollectionAction = 'read' | 'create' | 'update' | 'delete'
export type GlobalAction = 'read' | 'update'
export type ScopePreset = 'read-only' | 'editor' | 'admin'

/**
 * Runtime scope shape consumed by `registry.assertScopeAllows`.
 *
 * - `collections` / `globals` are whitelists when present: a resource not
 *   listed there is denied for this key.
 * - `tools.allow` / `tools.deny` are per-tool overrides that take precedence
 *   over the preset / resource maps.
 */
export interface KeyScopes {
  preset?: ScopePreset
  collections?: Record<string, CollectionAction[]>
  globals?: Record<string, GlobalAction[]>
  tools?: { allow?: string[]; deny?: string[] }
}
