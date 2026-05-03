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

    // 1. Schema introspection
    const collectionSchemas = introspectCollections(collections)
    const blockCatalog = introspectBlocks(allBlocks)
    const blockNesting = buildBlockNestingMap(collections, allBlocks)
    const relationships = buildRelationshipGraph(collectionSchemas)

    // 2. Resolve preview siteUrl from explicit option, then Payload's own
    //    serverURL, then conventional env vars. May still be undefined —
    //    that's fine; relative-path preview URLs are skipped in that case.
    const previewSiteUrl =
      options.preview?.siteUrl ??
      incomingConfig.serverURL ??
      process.env.NEXT_PUBLIC_SERVER_URL ??
      process.env.SITE_URL

    // 3. Generate prompts and resources
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

    // 4. Build MCP collection configs (preview URL + draft behavior)
    const { mcpCollections, draftCollections } = generateMcpCollectionConfigs(collections, {
      siteUrl: previewSiteUrl,
      draftBehavior: options.draftBehavior,
      excludeCollections: options.exclude?.collections,
      previewDisabled: options.preview?.disabled,
    })

    // 5. Build the searchable-fields map for resolveReference
    const searchableCollections = new Map<string, string[]>()
    for (const [slug, schema] of collectionSchemas) {
      if (schema.searchableFields.length > 0) {
        searchableCollections.set(slug, schema.searchableFields)
      }
    }

    // 6. Tools
    const tools: any[] = [
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

    // 7. Globals — expose every non-excluded global with default capabilities
    const mcpGlobals: Record<string, { enabled: boolean; description?: string }> = {}
    const excludeGlobalSlugs = new Set(options.exclude?.globals ?? [])
    for (const global of (incomingConfig.globals ?? []) as Array<{ slug: string }>) {
      if (excludeGlobalSlugs.has(global.slug)) continue
      mcpGlobals[global.slug] = {
        enabled: true,
        description: `Manage ${global.slug} global settings`,
      }
    }

    // 8. Apply the official MCP plugin with our generated config.
    //
    // userCollection: passthrough — when omitted, the official plugin falls
    // back to `incomingConfig.admin.user`, which is already the canonical
    // Payload way to declare your auth collection.
    //
    // overrideAuth: rebinds req.user from the API key's linked user so our
    // custom tools' overrideAccess: false runs against the right identity.
    // Safe — getDefault() throws inside the official plugin if the API key
    // has no linked user, so settings.user is guaranteed here.
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
