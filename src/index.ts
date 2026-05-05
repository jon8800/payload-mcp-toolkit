import type { Block, CollectionConfig, Config, Plugin } from 'payload'
import type { ContentToolkitOptions } from './types'
import {
  introspectCollections,
  introspectBlocks,
  buildBlockNestingMap,
  buildRelationshipGraph,
} from './introspection'
import { generatePrompts } from './prompts'
import { generateResources } from './resources'
import { computeDraftCollections } from './draft-workflow'
import { createApiKeysCollection, API_KEYS_DEFAULT_SLUG } from './api-keys'
import { createBearerStrategy } from './auth-strategy'
import { createMcpEndpoints } from './endpoint'
import { createInitializeServer, type ToolFactoryOutput } from './registry'
import { assertNoSlugConflict, assertNoUpstreamPlugin } from './conflict-detection'
import { createCreateDocumentTool } from './tools/create-document'
import { createDeleteDocumentTool } from './tools/delete-document'
import { createFindDocumentTool } from './tools/find-document'
import { createPatchLayoutTool } from './tools/patch-layout'
import { createPublishDraftTool } from './tools/publish-draft'
import { createResolveReferenceTool } from './tools/resolve-reference'
import { createSafeDeleteTool } from './tools/safe-delete'
import { createSchedulePublishTool } from './tools/schedule-publish'
import { createSearchContentTool } from './tools/search-content'
import { createUpdateDocumentTool } from './tools/update-document'
import { createUploadMediaTool } from './tools/upload-media'
import { createListVersionsTool, createRestoreVersionTool } from './tools/versions'

/**
 * Resolves the user collection slug for API-key linkage.
 *
 * Resolution order: explicit `options.apiKeyCollection.userCollection` →
 * explicit `options.userCollection` → `incomingConfig.admin.user` →
 * 'users' as a last resort.
 */
function resolveUserCollection(
  options: ContentToolkitOptions,
  incomingConfig: Config,
): string {
  return (
    options.apiKeyCollection?.userCollection ??
    options.userCollection ??
    (incomingConfig.admin?.user as string | undefined) ??
    'users'
  )
}

/**
 * payload-mcp-toolkit — standalone Payload v3 MCP plugin.
 *
 * Owns the `/api/mcp` endpoint, the `payload-mcp-api-keys` collection,
 * bearer authentication via Payload's `auth.strategies` extension point,
 * and the per-tool scope check. Upstream `@payloadcms/plugin-mcp` is no
 * longer required (and is incompatible — see `assertNoUpstreamPlugin`).
 *
 * Zero-config usage:
 * ```ts
 * plugins: [contentToolkitPlugin()]
 * ```
 *
 * See `ContentToolkitOptions` for the (entirely optional) escape hatches.
 */
export function contentToolkitPlugin(options: ContentToolkitOptions = {}): Plugin {
  return (incomingConfig: Config): Config => {
    const apiKeysSlug = options.apiKeyCollection?.slug ?? API_KEYS_DEFAULT_SLUG

    // Conflict detection — fail fast with actionable messages.
    assertNoUpstreamPlugin(incomingConfig.plugins)
    assertNoSlugConflict(incomingConfig.collections as CollectionConfig[] | undefined, apiKeysSlug)

    const collections = (incomingConfig.collections ?? []) as CollectionConfig[]
    const allBlocks = (incomingConfig.blocks ?? []) as Block[]

    const collectionSchemas = introspectCollections(collections)
    const blockCatalog = introspectBlocks(allBlocks)
    const blockNesting = buildBlockNestingMap(collections, allBlocks)
    const relationships = buildRelationshipGraph(collectionSchemas)

    const previewSiteUrl =
      options.preview?.siteUrl ??
      incomingConfig.serverURL ??
      process.env.NEXT_PUBLIC_SERVER_URL ??
      process.env.SITE_URL

    const { draftCollections, excluded } = computeDraftCollections(collections, {
      draftBehavior: options.draftBehavior,
      excludeCollections: options.exclude?.collections,
      apiKeysSlug,
    })

    // Build a slug → CollectionConfig map for tools that need access to
    // collection-level admin config (preview functions, etc).
    const collectionsBySlug = new Map<string, CollectionConfig>()
    for (const c of collections) {
      if (!excluded.has(c.slug)) collectionsBySlug.set(c.slug, c)
    }

    // Schemas-without-excluded view, used by the polymorphic tool factories
    // so excluded collections don't appear in tool descriptions.
    const exposedSchemas = new Map<string, ReturnType<typeof introspectCollections> extends Map<string, infer V> ? V : never>()
    for (const [slug, schema] of collectionSchemas) {
      if (!excluded.has(slug)) exposedSchemas.set(slug, schema)
    }

    const prompts = generatePrompts(
      exposedSchemas,
      blockCatalog,
      blockNesting,
      relationships,
      options.domainPrompts,
    )
    const resources = generateResources(exposedSchemas, blockCatalog, blockNesting, relationships)

    const searchableCollections = new Map<string, string[]>()
    for (const [slug, schema] of exposedSchemas) {
      if (schema.searchableFields.length > 0) {
        searchableCollections.set(slug, schema.searchableFields)
      }
    }

    const tools: ToolFactoryOutput[] = ([
      createCreateDocumentTool(exposedSchemas, draftCollections),
      createDeleteDocumentTool(exposedSchemas),
      createFindDocumentTool(exposedSchemas, draftCollections, collectionsBySlug, previewSiteUrl),
      createPatchLayoutTool(blockCatalog, blockNesting, draftCollections),
      createPublishDraftTool(draftCollections),
      createResolveReferenceTool(searchableCollections),
      createSafeDeleteTool(relationships),
      createSearchContentTool(exposedSchemas),
      createUpdateDocumentTool(exposedSchemas, draftCollections),
      createUploadMediaTool({
        maxFileSize: options.mediaUpload?.maxFileSize,
        collectionSlug: options.mediaUpload?.collectionSlug,
      }),
      createListVersionsTool(draftCollections),
      createRestoreVersionTool(draftCollections),
    ] as unknown) as ToolFactoryOutput[]

    const schedulePublish = createSchedulePublishTool(exposedSchemas, draftCollections)
    if (schedulePublish) tools.push(schedulePublish as unknown as ToolFactoryOutput)

    // Build the per-request initializer that mcp-handler invokes.
    const buildInitializeServer = createInitializeServer({
      tools,
      prompts: prompts as never,
      resources: resources as never,
    })

    // Attach API-keys collection.
    const userCollection = resolveUserCollection(options, incomingConfig)
    const apiKeysCollection = createApiKeysCollection({ slug: apiKeysSlug, userCollection })
    const updatedCollections: CollectionConfig[] = [...collections, apiKeysCollection]

    // Attach the bearer strategy to the user collection's auth config.
    const bearerStrategy = createBearerStrategy({
      collectionSlug: apiKeysSlug,
      userCollection,
    })
    const collectionsWithStrategy = updatedCollections.map((c) => {
      if (c.slug !== userCollection) return c
      const existingAuth = c.auth
      if (!existingAuth) return c
      const authConfig =
        typeof existingAuth === 'object' && existingAuth !== null
          ? { ...existingAuth }
          : { useAPIKey: existingAuth === true ? false : false }
      const existingStrategies = Array.isArray((authConfig as { strategies?: unknown[] }).strategies)
        ? ((authConfig as { strategies: unknown[] }).strategies as unknown[])
        : []
      ;(authConfig as { strategies: unknown[] }).strategies = [
        ...existingStrategies,
        bearerStrategy,
      ]
      return { ...c, auth: authConfig } as CollectionConfig
    })

    // Attach the MCP endpoints additively to the host config.
    const mcpEndpoints = createMcpEndpoints({
      buildInitializeServer,
      allowedOrigins: options.auth?.allowedOrigins,
      serverURL: incomingConfig.serverURL,
    })

    return {
      ...incomingConfig,
      collections: collectionsWithStrategy,
      endpoints: [...(incomingConfig.endpoints ?? []), ...mcpEndpoints],
    }
  }
}

export type {
  ContentToolkitOptions,
  DomainPrompt,
  CollectionSchema,
  BlockCatalog,
  BlockSchema,
  BlockNestingMap,
  BlockNestingEdge,
  RelationshipEdge,
  FieldSchema,
} from './types'

export type { CollectionAction, KeyScopes, ScopePreset } from './auth-strategy'
