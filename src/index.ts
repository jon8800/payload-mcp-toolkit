import type { Block, CollectionConfig, Config, Plugin } from 'payload'
import { mcpPlugin } from '@payloadcms/plugin-mcp'
import type { ContentToolkitOptions } from './types'
import { introspectCollections, introspectBlocks, buildRelationshipGraph } from './introspection'
import { generatePrompts } from './prompts'
import { generateResources } from './resources'
import { generateMcpCollectionConfigs } from './draft-workflow'
import { createComposeLayoutTool } from './tools/compose-layout'
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
 * A wrapper plugin that introspects the Payload config and generates
 * domain-aware MCP tools, prompts, and resources for AI content management.
 *
 * Usage in payload.config.ts:
 * ```ts
 * import { contentToolkitPlugin } from 'payload-mcp-toolkit'
 *
 * plugins: [
 *   contentToolkitPlugin({
 *     siteUrl: process.env.SITE_URL!,
 *     previewSecret: process.env.PREVIEW_SECRET!,
 *     previewPaths: { posts: '/blog', pages: '' },
 *     draftBehavior: { pages: 'always-draft' },
 *   }),
 * ]
 * ```
 */
export function contentToolkitPlugin(options: ContentToolkitOptions): Plugin {
  return (incomingConfig: Config): Config => {
    const collections = (incomingConfig.collections ?? []) as CollectionConfig[]
    const allBlocks = (incomingConfig.blocks ?? []) as Block[]

    // Separate section blocks from leaf blocks.
    //
    // Preferred: `options.sectionBlockSlugs` — explicit, unambiguous.
    // Fallback heuristic: blocks containing a nested `blocks`-type field are
    // sections, all others are leaves. The heuristic mis-classifies "fixed"
    // sections (no nested blocks but their own standalone fields), so prefer
    // the explicit option whenever the schema has any fixed sections.
    const sectionBlocks: Block[] = []
    const leafBlocks: Block[] = []

    if (options.sectionBlockSlugs && options.sectionBlockSlugs.length > 0) {
      const sectionSlugs = new Set(options.sectionBlockSlugs)
      for (const block of allBlocks) {
        if (sectionSlugs.has(block.slug)) {
          sectionBlocks.push(block)
        } else {
          leafBlocks.push(block)
        }
      }
    } else {
      for (const block of allBlocks) {
        const hasBlocksField = block.fields.some(
          (f) => f.type === 'blocks' ||
          (f.type === 'tabs' && 'tabs' in f && f.tabs.some(
            (tab: any) => 'fields' in tab && tab.fields.some((tf: any) => tf.type === 'blocks')
          ))
        )
        if (hasBlocksField) {
          sectionBlocks.push(block)
        } else {
          leafBlocks.push(block)
        }
      }
    }

    // 1. Schema Introspection
    const collectionSchemas = introspectCollections(collections)
    const blockCatalog = introspectBlocks(sectionBlocks, leafBlocks)
    const relationships = buildRelationshipGraph(collectionSchemas)

    // 2. Generate Prompts
    const prompts = generatePrompts(
      collectionSchemas,
      blockCatalog,
      relationships,
      options.domainPrompts,
    )

    // 3. Generate Resources
    const resources = generateResources(collectionSchemas, blockCatalog, relationships)

    // 4. Generate Tools
    const searchableCollections = new Map<string, string[]>()
    for (const [slug, schema] of collectionSchemas) {
      if (schema.searchableFields.length > 0) {
        searchableCollections.set(slug, schema.searchableFields)
      }
    }

    // 5. Generate MCP Collection Configs with draft workflow
    const { mcpCollections, draftCollections } = generateMcpCollectionConfigs(collections, {
      siteUrl: options.siteUrl,
      previewSecret: options.previewSecret,
      previewPaths: options.previewPaths,
      draftBehavior: options.draftBehavior,
      excludeCollections: options.excludeCollections,
    })

    const tools: any[] = [
      createComposeLayoutTool(blockCatalog),
      createPatchLayoutTool(blockCatalog, draftCollections),
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

    // schedulePublish only registers when at least one draft collection has a `publishedAt` date field
    const schedulePublish = createSchedulePublishTool(collectionSchemas, draftCollections)
    if (schedulePublish) tools.push(schedulePublish)

    // Build MCP global configs
    const mcpGlobals: Record<string, { enabled: boolean; description?: string }> = {}
    const excludeGlobalSlugs = new Set(options.excludeGlobals ?? [])

    for (const global of (incomingConfig.globals ?? []) as Array<{ slug: string }>) {
      if (excludeGlobalSlugs.has(global.slug)) continue
      mcpGlobals[global.slug] = {
        enabled: true,
        description: `Manage ${global.slug} global settings`,
      }
    }

    // Apply the official MCP plugin with our generated config
    const withMcp = mcpPlugin({
      collections: mcpCollections as any,
      globals: mcpGlobals as any,
      mcp: {
        tools: tools as any[],
        prompts: prompts as any[],
        resources: resources as any[],
      },
      // Set req.user from the API key's linked user so custom tools
      // can use overrideAccess: false and relationship field validation
      // has a valid user context for access control checks.
      // Safe: getDefault() throws inside the official plugin if the API key
      // has no linked user, so settings.user is guaranteed to exist here.
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
  DraftBehavior,
  CollectionSchema,
  BlockCatalog,
  SectionBlockSchema,
  LeafBlockSchema,
  RelationshipEdge,
  FieldSchema,
} from './types'
