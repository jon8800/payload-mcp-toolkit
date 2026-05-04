import type { Block, CollectionConfig, Config, Plugin } from 'payload'
import { mcpPlugin } from '@payloadcms/plugin-mcp'
import type { ContentToolkitOptions } from './types'
import {
  introspectCollections,
  introspectBlocks,
  buildBlockNestingMap,
  buildRelationshipGraph,
} from './introspection'
import { generatePrompts } from './prompts'
import { generateResources } from './resources'
import { generateMcpCollectionConfigs } from './draft-workflow'
import { createCreateDocumentTool } from './tools/create-document'
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
 * Payload MCP Toolkit
 *
 * Layered on top of the official @payloadcms/plugin-mcp. The toolkit
 * introspects your Payload config and registers schema-aware prompts,
 * resources, and tools so AI clients can drive the CMS without
 * hand-built plumbing.
 *
 * Zero-config usage:
 * ```ts
 * plugins: [contentToolkitPlugin()]
 * ```
 *
 * Every option below is an optional escape hatch — see ContentToolkitOptions.
 */
export function contentToolkitPlugin(options: ContentToolkitOptions = {}): Plugin {
  return (incomingConfig: Config): Config => {
    const collections = (incomingConfig.collections ?? []) as CollectionConfig[]
    const allBlocks = (incomingConfig.blocks ?? []) as Block[]

    const collectionSchemas = introspectCollections(collections)
    const blockCatalog = introspectBlocks(allBlocks)
    const blockNesting = buildBlockNestingMap(collections, allBlocks)
    const relationships = buildRelationshipGraph(collectionSchemas)

    // Preview siteUrl resolves: explicit option → Payload serverURL → env vars.
    // May be undefined; relative-path preview URLs are skipped in that case.
    const previewSiteUrl =
      options.preview?.siteUrl ??
      incomingConfig.serverURL ??
      process.env.NEXT_PUBLIC_SERVER_URL ??
      process.env.SITE_URL

    const prompts = generatePrompts(
      collectionSchemas,
      blockCatalog,
      blockNesting,
      relationships,
      options.domainPrompts,
    )
    const resources = generateResources(
      collectionSchemas,
      blockCatalog,
      blockNesting,
      relationships,
    )

    const { mcpCollections, draftCollections } = generateMcpCollectionConfigs(collections, {
      siteUrl: previewSiteUrl,
      draftBehavior: options.draftBehavior,
      excludeCollections: options.exclude?.collections,
      previewDisabled: options.preview?.disabled,
    })

    const searchableCollections = new Map<string, string[]>()
    for (const [slug, schema] of collectionSchemas) {
      if (schema.searchableFields.length > 0) {
        searchableCollections.set(slug, schema.searchableFields)
      }
    }

    const tools: any[] = [
      createCreateDocumentTool(collectionSchemas, draftCollections),
      createPatchLayoutTool(blockCatalog, blockNesting, draftCollections),
      createPublishDraftTool(draftCollections),
      createResolveReferenceTool(searchableCollections),
      createSafeDeleteTool(relationships),
      createSearchContentTool(collectionSchemas),
      createUpdateDocumentTool(collectionSchemas, draftCollections),
      createUploadMediaTool({
        maxFileSize: options.mediaUpload?.maxFileSize,
        collectionSlug: options.mediaUpload?.collectionSlug,
      }),
      createListVersionsTool(draftCollections),
      createRestoreVersionTool(draftCollections),
    ]

    const schedulePublish = createSchedulePublishTool(collectionSchemas, draftCollections)
    if (schedulePublish) tools.push(schedulePublish)

    // Globals get `find` only. The official plugin's `update<Global>` tool
    // hits the same `convertCollectionSchemaToZod` path that crashes on
    // richText / upload / blocks fields (here it throws
    // `Cannot convert undefined or null to object` because globals/update.ts
    // calls `Object.entries(convertedFields.shape)` and the fallback
    // `z.record()` has no `.shape`). Until the toolkit's `updateDocument`
    // gains global support, edit globals via the admin panel.
    const mcpGlobals: Record<
      string,
      { enabled: { find: boolean; update: boolean }; description?: string }
    > = {}
    const excludeGlobalSlugs = new Set(options.exclude?.globals ?? [])
    for (const global of (incomingConfig.globals ?? []) as Array<{ slug: string }>) {
      if (excludeGlobalSlugs.has(global.slug)) continue
      mcpGlobals[global.slug] = {
        enabled: { find: true, update: false },
        description: `Read ${global.slug} global settings`,
      }
    }

    // overrideAuth rebinds req.user from the API key's linked user so our
    // custom tools' `overrideAccess: false` checks run against the right
    // identity. userCollection passthrough lets the official plugin fall
    // back to `incomingConfig.admin.user`.
    const withMcp = mcpPlugin({
      collections: mcpCollections as any,
      globals: mcpGlobals as any,
      userCollection: options.userCollection as any,
      mcp: {
        tools: tools as any[],
        prompts: prompts as any[],
        resources: resources as any[],
      },
      overrideAuth: async (req, getDefault) => {
        const settings = await getDefault()
        req.user = (settings as any).user
        return settings
      },
    })

    return withMcp(incomingConfig)
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
