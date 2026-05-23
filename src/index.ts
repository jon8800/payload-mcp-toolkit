import type { Block, CollectionConfig, Config, GlobalConfig, Plugin } from 'payload'
import type { ContentToolkitOptions, GlobalSchema } from './types'
import {
  introspectCollections,
  introspectGlobals,
  introspectBlocks,
  buildBlockNestingMap,
  buildRelationshipGraph,
} from './introspection'
import { generatePrompts } from './prompts'
import { generateResources } from './resources'
import { computeDraftCollections, computeDraftGlobals } from './draft-workflow'
import { createApiKeysCollection, API_KEYS_DEFAULT_SLUG } from './api-keys'
import { createBearerStrategy } from './auth-strategy'
import { createMcpEndpoints } from './endpoint'
import {
  createInitializeServer,
  type ToolFactoryOutput,
} from './registry'
import { assertNoSlugConflict, assertNoUpstreamPlugin } from './conflict-detection'
import { createCreateDocumentTool } from './tools/create-document'
import { createDeleteDocumentTool } from './tools/delete-document'
import { createFindDocumentTool } from './tools/find-document'
import { createFindGlobalTool } from './tools/find-global'
import { createUpdateGlobalTool } from './tools/update-global'
import { createPatchGlobalLayoutTool } from './tools/patch-global-layout'
import { createPublishGlobalDraftTool } from './tools/publish-global-draft'
import {
  createListGlobalVersionsTool,
  createRestoreGlobalVersionTool,
} from './tools/global-versions'
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
 * plugins: [mcpToolkitPlugin()]
 * ```
 *
 * See `ContentToolkitOptions` for the (entirely optional) escape hatches.
 */
export function mcpToolkitPlugin(options: ContentToolkitOptions = {}): Plugin {
  return (incomingConfig: Config): Config => {
    const apiKeysSlug = options.apiKeyCollection?.slug ?? API_KEYS_DEFAULT_SLUG

    // Conflict detection — fail fast with actionable messages.
    assertNoUpstreamPlugin(incomingConfig.plugins)
    assertNoSlugConflict(incomingConfig.collections as CollectionConfig[] | undefined, apiKeysSlug)

    const collections = (incomingConfig.collections ?? []) as CollectionConfig[]
    const globals = (incomingConfig.globals ?? []) as GlobalConfig[]
    const allBlocks = (incomingConfig.blocks ?? []) as Block[]

    const collectionSchemas = introspectCollections(collections)
    const globalSchemas = introspectGlobals(globals)
    const blockCatalog = introspectBlocks(allBlocks)
    const relationships = buildRelationshipGraph(collectionSchemas)

    const previewSiteUrl = options.preview?.disabled
      ? undefined
      : options.preview?.siteUrl ??
        incomingConfig.serverURL ??
        process.env.NEXT_PUBLIC_SERVER_URL ??
        process.env.SITE_URL
    const previewDisabled = options.preview?.disabled === true

    const { draftCollections, excluded } = computeDraftCollections(collections, {
      draftBehavior: options.draftBehavior,
      excludeCollections: options.exclude?.collections,
      apiKeysSlug,
    })

    const { draftGlobals, excluded: excludedGlobals } = computeDraftGlobals(globals, {
      draftBehavior: options.draftBehavior,
      excludeGlobals: options.exclude?.globals,
    })

    // Build blockNesting from exclusion-filtered inputs so excluded
    // collections/globals never appear in patchLayout/patchGlobalLayout slug
    // enums or in the `blocks://nesting` resource body.
    const exposedCollectionsForNesting = collections.filter((c) => !excluded.has(c.slug))
    const exposedGlobalsForNesting = globals.filter((g) => !excludedGlobals.has(g.slug))
    const blockNesting = buildBlockNestingMap(
      exposedCollectionsForNesting,
      exposedGlobalsForNesting,
      allBlocks,
    )

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

    // Same shape for globals — excluded slugs are stripped at registration
    // time so they never reach Zod input enums, the globals://schema
    // resource, or availableGlobals on the admin matrix. composeScopes
    // stays exclusion-unaware (mirrors the collection mechanism).
    const exposedGlobalSchemas = new Map<string, GlobalSchema>()
    const globalsBySlug = new Map<string, GlobalConfig>()
    for (const [slug, schema] of globalSchemas) {
      if (excludedGlobals.has(slug)) continue
      exposedGlobalSchemas.set(slug, schema)
    }
    for (const g of globals) {
      if (!excludedGlobals.has(g.slug)) globalsBySlug.set(g.slug, g)
    }

    const prompts = generatePrompts(
      exposedSchemas,
      blockCatalog,
      blockNesting,
      relationships,
      options.domainPrompts,
    )
    const resources = generateResources(
      exposedSchemas,
      blockCatalog,
      blockNesting,
      relationships,
      exposedGlobalSchemas,
    )

    const searchableCollections = new Map<string, string[]>()
    for (const [slug, schema] of exposedSchemas) {
      if (schema.searchableFields.length > 0) {
        searchableCollections.set(slug, schema.searchableFields)
      }
    }

    const tools: ToolFactoryOutput[] = [
      createCreateDocumentTool(exposedSchemas, draftCollections),
      createDeleteDocumentTool(exposedSchemas),
      createFindDocumentTool(
        exposedSchemas,
        draftCollections,
        collectionsBySlug,
        previewSiteUrl,
        previewDisabled,
      ),
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
    ]

    const schedulePublish = createSchedulePublishTool(exposedSchemas, draftCollections)
    if (schedulePublish) tools.push(schedulePublish)

    // Global tools — registered only when at least one global is exposed.
    if (exposedGlobalSchemas.size > 0) {
      tools.push(
        createFindGlobalTool(
          exposedGlobalSchemas,
          draftGlobals,
          globalsBySlug,
          previewSiteUrl,
          previewDisabled,
        ),
        createUpdateGlobalTool(exposedGlobalSchemas, draftGlobals),
      )

      const patchGlobalLayout = createPatchGlobalLayoutTool(blockCatalog, blockNesting, draftGlobals)
      if (patchGlobalLayout) tools.push(patchGlobalLayout)

      const publishGlobalDraft = createPublishGlobalDraftTool(draftGlobals)
      if (publishGlobalDraft) tools.push(publishGlobalDraft)

      const listGlobalVersions = createListGlobalVersionsTool(draftGlobals)
      if (listGlobalVersions) tools.push(listGlobalVersions)

      const restoreGlobalVersion = createRestoreGlobalVersionTool(draftGlobals)
      if (restoreGlobalVersion) tools.push(restoreGlobalVersion)
    }

    // Build the per-request initializer that mcp-handler invokes.
    const buildInitializeServer = createInitializeServer({
      tools,
      prompts: prompts as never,
      resources: resources as never,
    })

    // Attach API-keys collection. Available collections / tools are
    // snapshotted now so the admin UI's scope dropdowns reflect the host
    // config at boot time. Adding a collection requires a dev restart for
    // it to surface as a scope option.
    const userCollection = resolveUserCollection(options, incomingConfig)
    const availableCollections = collections
      .map((c) => c.slug)
      .filter((s) => s !== apiKeysSlug)
    const availableGlobals = [...exposedGlobalSchemas.keys()]
    const availableTools = tools.map((t) => t.name)
    const apiKeysCollection = createApiKeysCollection({
      slug: apiKeysSlug,
      userCollection,
      availableCollections,
      availableGlobals,
      availableTools,
    })
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
  GlobalSchema,
  BlockCatalog,
  BlockSchema,
  BlockNestingMap,
  BlockNestingEdge,
  RelationshipEdge,
  FieldSchema,
  CollectionAction,
  GlobalAction,
  KeyScopes,
  ScopePreset,
} from './types'
