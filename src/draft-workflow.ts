import type { CollectionConfig, PayloadRequest } from 'payload'
import { hasCollectionDrafts } from './introspection'

/** MCP response shape used by overrideResponse */
interface McpResponse {
  content: Array<{ text: string; type: string }>
}

/** Per-collection MCP config with enabled operations and optional overrideResponse */
interface McpCollectionConfig {
  description: string
  enabled: {
    create: boolean
    delete: boolean
    find: boolean
    update: boolean
  }
  overrideResponse?: (
    response: McpResponse,
    doc: Record<string, unknown>,
    req: PayloadRequest,
  ) => McpResponse | Promise<McpResponse>
}

interface GenerateOptions {
  /**
   * Optional absolute base URL prepended to relative preview paths returned
   * by the collection's own preview URL function. Resolved upstream from
   * (in order): `options.preview.siteUrl`, `incomingConfig.serverURL`,
   * `process.env.NEXT_PUBLIC_SERVER_URL`, `process.env.SITE_URL`. May be
   * undefined — relative-path returns will then be skipped.
   */
  siteUrl?: string
  /** Per-collection draft behavior overrides */
  draftBehavior?: Record<string, 'always-draft' | 'always-publish'>
  /** Collection slugs to exclude from MCP */
  excludeCollections?: string[]
  /** Disable preview URL injection entirely */
  previewDisabled?: boolean
}

/**
 * Determines the draft behavior for a collection.
 *
 * - No drafts configured → 'publish' (raw update allowed; no draft concept)
 * - Drafts configured + override given → use override
 * - Drafts configured + no override → 'always-draft' (raw update locked)
 */
export function getDraftBehavior(
  collection: CollectionConfig,
  options?: { draftBehavior?: Record<string, 'always-draft' | 'always-publish'> },
): 'always-draft' | 'always-publish' | 'publish' {
  if (!hasCollectionDrafts(collection)) return 'publish'

  const override = options?.draftBehavior?.[collection.slug]
  if (override) return override

  return 'always-draft'
}

/**
 * Build a preview URL for a draft document by delegating to the collection's
 * own configured preview URL function. Tries `admin.livePreview.url` first
 * (the modern API), then `admin.preview` (the older `GeneratePreviewURL`).
 *
 * If neither is configured, or the function returns null/undefined/empty,
 * returns null and the override response will skip preview injection.
 */
async function resolvePreviewUrl(
  collection: CollectionConfig,
  doc: Record<string, unknown>,
  req: PayloadRequest,
  siteUrl: string | undefined,
): Promise<string | null> {
  const admin = (collection.admin ?? {}) as Record<string, any>
  const locale = (req as any).locale ?? 'en'

  let raw: string | null | undefined

  const livePreviewUrl = admin.livePreview?.url
  if (typeof livePreviewUrl === 'function') {
    try {
      raw = await livePreviewUrl({
        data: doc,
        locale: { code: locale, label: locale },
        req,
        payload: req.payload,
        collectionConfig: collection as any,
      })
    } catch {
      raw = null
    }
  } else if (typeof livePreviewUrl === 'string') {
    raw = livePreviewUrl
  }

  if (!raw && typeof admin.preview === 'function') {
    try {
      raw = await admin.preview(doc, {
        locale,
        req,
        token: null,
      })
    } catch {
      raw = null
    }
  }

  if (!raw || typeof raw !== 'string') return null

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw
  }

  if (!siteUrl) return null

  const base = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl
  const path = raw.startsWith('/') ? raw : `/${raw}`
  return `${base}${path}`
}

function createOverrideResponse(
  collection: CollectionConfig,
  siteUrl: string | undefined,
): McpCollectionConfig['overrideResponse'] {
  return async (response, doc, req): Promise<McpResponse> => {
    if (doc._status !== 'draft') return response

    const previewUrl = await resolvePreviewUrl(collection, doc, req, siteUrl)
    if (!previewUrl) {
      return {
        content: [
          ...response.content,
          {
            type: 'text',
            text: '\n📋 This document is a draft. Use the admin panel to preview it.',
          },
        ],
      }
    }

    return {
      content: [
        ...response.content,
        {
          type: 'text',
          text: `\n📋 This document is a draft. Preview it here: ${previewUrl}`,
        },
      ],
    }
  }
}

/**
 * Generates the mcpCollections config object for the official mcpPlugin.
 *
 * For each non-excluded collection:
 * - Enables `find` / `create` / `delete`; disables the official plugin's
 *   raw `update<Resource>` tool universally. The toolkit's `updateDocument`
 *   and `patchLayout` cover updates via the local API (and survive the
 *   upload-field / schema-conversion bugs in the official plugin's update
 *   path). Draft semantics are preserved by `publishDraft`.
 * - For draft collections: attaches an `overrideResponse` that appends a
 *   preview URL — sourced from the collection's own livePreview/preview
 *   function — to draft documents. Falls back to a generic admin-panel
 *   message when no preview function is configured.
 *
 * @returns Map of slug → MCP collection config, plus the set of draft slugs
 */
export function generateMcpCollectionConfigs(
  collections: CollectionConfig[],
  options: GenerateOptions,
): {
  mcpCollections: Record<string, McpCollectionConfig>
  draftCollections: Set<string>
} {
  const mcpCollections: Record<string, McpCollectionConfig> = {}
  const draftCollections = new Set<string>()

  const excludeSlugs = new Set([
    'payload-mcp-api-keys',
    ...(options.excludeCollections ?? []),
  ])

  for (const collection of collections) {
    if (excludeSlugs.has(collection.slug)) continue

    // Auth-enabled collections are users — never expose them via MCP.
    if ((collection as any).auth) continue

    const behavior = getDraftBehavior(collection, options)

    if (behavior !== 'publish') {
      draftCollections.add(collection.slug)
    }

    // Always disable the official plugin's per-collection `update<Resource>` tool.
    // It calls `convertCollectionSchemaToZod` and crashes on any collection
    // whose JSON schema can't be losslessly converted (richText, upload,
    // blocks fields → fallback returns `z.record()`, then `.partial()` throws).
    // The toolkit's `updateDocument` and `patchLayout` cover updates via the
    // local API and survive the upload-field / schema-conversion bugs, so the
    // raw update tool is redundant. See README "What it adds → updateDocument".
    const enabled = {
      find: true,
      create: true,
      update: false,
      delete: true,
    }

    const config: McpCollectionConfig = {
      description: `Manage ${collection.slug} content`,
      enabled,
    }

    if (draftCollections.has(collection.slug) && !options.previewDisabled) {
      config.overrideResponse = createOverrideResponse(collection, options.siteUrl)
    }

    mcpCollections[collection.slug] = config
  }

  return { mcpCollections, draftCollections }
}
