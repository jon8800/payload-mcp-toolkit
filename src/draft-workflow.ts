import type { CollectionConfig, PayloadRequest } from 'payload'
import type { DraftBehavior } from './types'

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
  ) => McpResponse
}

interface GenerateOptions {
  /** Base site URL for preview links */
  siteUrl: string
  /** Preview authentication secret */
  previewSecret: string
  /**
   * Per-collection URL path prefix used when constructing preview URLs.
   * Defaults to `/{slug}` for collections not in the map.
   */
  previewPaths?: Record<string, string>
  /** Per-collection draft behavior overrides */
  draftBehavior?: Record<string, DraftBehavior>
  /** Collection slugs to exclude from MCP */
  excludeCollections?: string[]
}

/**
 * Determines the draft behavior for a collection based on its config and user overrides.
 *
 * - If the collection has no `versions.drafts`: always 'publish' regardless of override
 * - If the user specified an override: use that override
 * - Default: 'always-draft' for draft-enabled collections, 'publish' for others
 */
export function getDraftBehavior(
  collection: CollectionConfig,
  options?: { draftBehavior?: Record<string, DraftBehavior> },
): 'always-draft' | 'always-publish' | 'publish' {
  const hasDrafts =
    typeof collection.versions === 'object' &&
    collection.versions !== null &&
    'drafts' in collection.versions &&
    Boolean(collection.versions.drafts)

  if (!hasDrafts) return 'publish'

  const override = options?.draftBehavior?.[collection.slug]
  if (override) return override

  return 'always-draft'
}

/**
 * Builds a preview URL for a draft document.
 *
 * Path is `${siteUrl}/next/preview?...`. Path prefix per collection comes
 * from `previewPaths`, defaulting to `/{collectionSlug}` when not configured.
 */
function buildPreviewUrl(
  doc: Record<string, unknown>,
  collectionSlug: string,
  siteUrl: string,
  previewSecret: string,
  previewPaths?: Record<string, string>,
): string {
  const slug = (doc.slug as string) || ''
  const prefix = previewPaths?.[collectionSlug] ?? `/${collectionSlug}`
  const path = `${prefix}/${slug}`

  const params = new URLSearchParams({
    slug,
    collection: collectionSlug,
    path,
    previewSecret,
  })

  return `${siteUrl}/next/preview?${params.toString()}`
}

/**
 * Creates an overrideResponse function for a draft-enabled collection.
 * When a document has `_status === 'draft'`, appends a preview URL to the response.
 */
function createOverrideResponse(
  collectionSlug: string,
  siteUrl: string,
  previewSecret: string,
  previewPaths?: Record<string, string>,
): McpCollectionConfig['overrideResponse'] {
  return (response: McpResponse, doc: Record<string, unknown>): McpResponse => {
    if (doc._status !== 'draft') return response

    const previewUrl = buildPreviewUrl(doc, collectionSlug, siteUrl, previewSecret, previewPaths)

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
 * For each collection:
 * - Determines enabled CRUD operations based on draft behavior
 * - For 'always-draft' collections: disables raw `update` to force clients through publishDraft tool
 * - Generates `overrideResponse` that appends preview URLs for draft documents
 *
 * @returns A record of collection slug to MCP collection config, plus the set of draft collection slugs
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
    'users',
    'payload-mcp-api-keys',
    ...(options.excludeCollections ?? []),
  ])

  for (const collection of collections) {
    if (excludeSlugs.has(collection.slug)) continue

    const behavior = getDraftBehavior(collection, options)

    if (behavior !== 'publish') {
      draftCollections.add(collection.slug)
    }

    const enabled = {
      find: true,
      create: true,
      update: behavior !== 'always-draft',
      delete: true,
    }

    const config: McpCollectionConfig = {
      description: `Manage ${collection.slug} content`,
      enabled,
    }

    if (draftCollections.has(collection.slug)) {
      config.overrideResponse = createOverrideResponse(
        collection.slug,
        options.siteUrl,
        options.previewSecret,
        options.previewPaths,
      )
    }

    mcpCollections[collection.slug] = config
  }

  return { mcpCollections, draftCollections }
}
