import { z } from 'zod'
import type { CollectionConfig, PayloadRequest } from 'payload'
import type { CollectionSchema } from '../types'
import {
  decorateDraftResponse,
  errorMessage,
  jsonResponse,
  stampMcpContext,
  textResponse,
} from './_helpers'

interface FindDocumentArgs {
  collection: string
  id?: string
  where?: string
  limit?: number
  depth?: number
  draft?: boolean
}

/**
 * Polymorphic replacement for the upstream plugin's per-collection
 * `find<Resource>` tools. Takes the collection as an arg rather than
 * generating one tool per collection — same authoring shape as
 * `createDocument` / `updateDocument`.
 *
 * Two modes:
 *   - `id` set:  `payload.findByID` (single doc)
 *   - `id` unset: `payload.find` with optional JSON-string `where`
 *
 * Draft-enabled collections get preview URLs appended to draft documents
 * via `decorateDraftResponse`.
 */
export function createFindDocumentTool(
  collectionSchemas: Map<string, CollectionSchema>,
  draftCollections: Set<string>,
  collectionsBySlug: Map<string, CollectionConfig>,
  previewSiteUrl: string | undefined,
) {
  const findableSlugs = [...collectionSchemas.keys()]
  const descriptionLines = findableSlugs.map(
    (slug) =>
      `  - "${slug}"${draftCollections.has(slug) ? ' (draft-enabled)' : ''}`,
  )

  return {
    name: 'findDocument',
    description:
      'Read documents from any collection. Pass `id` for a single document, or omit `id` and pass a Payload `where` filter as a JSON string for a list. ' +
      'Draft-enabled collections include a preview URL on draft documents when available.\n\n' +
      'Available collections:\n' +
      descriptionLines.join('\n'),
    parameters: {
      collection: z
        .string()
        .describe(`The collection slug. One of: ${findableSlugs.join(', ')}`),
      id: z.string().optional().describe('Document ID. When set, returns a single document.'),
      where: z
        .string()
        .optional()
        .describe(
          'JSON-encoded Payload `where` clause. Examples: \'{"status":{"equals":"published"}}\', ' +
            '\'{"slug":{"equals":"hello-world"}}\'. Ignored if `id` is set.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('Max results when listing. Default 25.'),
      depth: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe('Relationship population depth. Default 1.'),
      draft: z
        .boolean()
        .optional()
        .describe(
          'When true, returns draft versions of draft-enabled collections. Default false (published only).',
        ),
    },
    handler: async (
      args: FindDocumentArgs,
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { collection, id, where, limit, depth, draft } = args

      if (!collectionSchemas.has(collection)) {
        return textResponse(
          `Error: Unknown collection "${collection}". Valid: ${findableSlugs.join(', ')}`,
        )
      }

      stampMcpContext(req)
      const collectionConfig = collectionsBySlug.get(collection)

      try {
        if (id) {
          const doc = await req.payload.findByID({
            collection: collection as never,
            id,
            depth: depth ?? 1,
            draft: draft ?? false,
            req,
            overrideAccess: false,
            user: req.user,
          })
          const base = jsonResponse(doc)
          return await decorateDraftResponse(
            base,
            doc as Record<string, unknown>,
            collectionConfig,
            req,
            previewSiteUrl,
          )
        }

        let parsedWhere: unknown
        if (where && where.trim().length > 0) {
          try {
            parsedWhere = JSON.parse(where)
          } catch (err) {
            return textResponse(
              `Error: \`where\` must be a valid JSON string. ${errorMessage(err)}`,
            )
          }
        }

        const result = await req.payload.find({
          collection: collection as never,
          where: parsedWhere as never,
          depth: depth ?? 1,
          limit: limit ?? 25,
          draft: draft ?? false,
          req,
          overrideAccess: false,
          user: req.user,
          pagination: false,
        })

        const base = jsonResponse({
          totalDocs: (result as { totalDocs?: number }).totalDocs ?? result.docs.length,
          docs: result.docs,
        })

        if (!collectionConfig || !draftCollections.has(collection)) return base

        // Decorate any draft docs in the page with preview URLs.
        let decorated = base
        for (const doc of result.docs as Array<Record<string, unknown>>) {
          if (doc._status === 'draft') {
            decorated = await decorateDraftResponse(
              decorated,
              doc,
              collectionConfig,
              req,
              previewSiteUrl,
            )
          }
        }
        return decorated
      } catch (err) {
        return textResponse(
          `Error reading from ${collection}: ${errorMessage(err)}`,
        )
      }
    },
  }
}
