import { z } from 'zod'
import type { CollectionConfig, PayloadRequest } from 'payload'
import type { CollectionSchema } from '../types.js'
import {
  decorateDraftResponse,
  errorMessage,
  jsonResponse,
  stampMcpContext,
  textResponse, hasDottedPath, LIMITED_SCOPE, populateDepth, parseDocumentId, selectParam, toSelect,
  trimmedUploadPopulate } from './_helpers.js'

interface FindDocumentArgs {
  collection: string
  documentId?: string
  where?: string
  limit?: number
  depth?: number
  draft?: boolean
  select?: string[]
  full?: boolean
}

/**
 * Fields a list returns when the caller passes neither `select` nor `full`. A list of 5 pages with
 * full block layouts ran to ~489k characters; a summary is enough to pick one, then read it whole
 * by `documentId`. Payload ignores keys the collection does not have.
 */
export function summaryFields(collection: CollectionConfig | undefined): string[] {
  const useAsTitle = collection?.admin?.useAsTitle
  return [...new Set([...(useAsTitle ? [useAsTitle] : []), 'title', 'name', 'slug', '_status', 'updatedAt'])]
}

/**
 * Polymorphic replacement for the upstream plugin's per-collection
 * `find<Resource>` tools. Takes the collection as an arg rather than
 * generating one tool per collection — same authoring shape as
 * `createDocument` / `updateDocument`.
 *
 * Two modes:
 *   - `documentId` set:   `payload.findByID` (single doc, complete, depth 1)
 *   - `documentId` unset: `payload.find` with optional JSON-string `where`
 *     (summary fields, depth 0, unless `select` / `full` / `depth` say otherwise)
 *
 * Draft-enabled collections get preview URLs appended to draft documents
 * via `decorateDraftResponse`.
 */
export function createFindDocumentTool(
  collectionSchemas: Map<string, CollectionSchema>,
  draftCollections: Set<string>,
  collectionsBySlug: Map<string, CollectionConfig>,
  previewSiteUrl: string | undefined,
  previewDisabled = false,
) {
  const findableSlugs = [...collectionSchemas.keys()]
  const descriptionLines = findableSlugs.map(
    (slug) =>
      `  - "${slug}"${draftCollections.has(slug) ? ' (draft-enabled)' : ''}`,
  )

  return {
    name: 'findDocument',
    routing: { kind: 'collection', action: 'read' } as const,
    description:
      'Read documents from any collection. Pass `documentId` for a single document, or omit `documentId` and pass a Payload `where` filter as a JSON string for a list. ' +
      'A single document comes back complete. A list returns summary fields only (id, title or name, slug, _status, updatedAt) at depth 0; ' +
      'pass `select` for chosen fields or `full: true` for whole documents. List first, then read one document by `documentId`. ' +
      'Draft-enabled collections include a preview URL on draft documents when available.\n\n' +
      'Available collections:\n' +
      descriptionLines.join('\n'),
    parameters: {
      collection: z
        .string()
        .describe(`The collection slug. One of: ${findableSlugs.join(', ')}`),
      documentId: z
        .string()
        .optional()
        .describe('Document ID. When set, returns a single document.'),
      where: z
        .string()
        .optional()
        .describe(
          'JSON-encoded Payload `where` clause. Examples: \'{"status":{"equals":"published"}}\', ' +
            '\'{"slug":{"equals":"hello-world"}}\'. Ignored if `documentId` is set.',
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
        .describe(
          'How many levels of linked entries (relationships, uploads) to fill in. 0 returns linked entries as IDs. ' +
            'Default 0 for lists, 1 for a single document.',
        ),
      draft: z
        .boolean()
        .optional()
        .describe(
          'When true, returns draft versions of draft-enabled collections. Default false (published only).',
        ),
      select: selectParam(' Works for single documents and lists. Replaces the summary fields of a list.'),
      full: z
        .boolean()
        .optional()
        .describe(
          'When true, a list returns whole documents instead of summary fields, and linked uploads keep every image size variant ' +
            '(by default linked uploads leave out `sizes`). Large: prefer `select`.',
        ),
    },
    handler: async (
      rawArgs: Record<string, unknown>,
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const args = rawArgs as unknown as FindDocumentArgs
      const { collection, documentId, where, limit, depth, draft, select, full } = args

      if (!collectionSchemas.has(collection)) {
        return textResponse(
          `Error: Unknown collection "${collection}". Valid: ${findableSlugs.join(', ')}`,
        )
      }

      stampMcpContext(req)
      const collectionConfig = collectionsBySlug.get(collection)
      const populate = trimmedUploadPopulate(req, full)

      try {
        if (documentId) {
          const doc = await req.payload.findByID({
            collection: collection as never,
            id: parseDocumentId(req, collection, documentId),
            depth: populateDepth(req, depth ?? 1),
            draft: draft ?? false,
            ...(select?.length ? { select: toSelect(select) as never } : {}),
            ...(populate ? { populate: populate as never } : {}),
            req,
            overrideAccess: false,
            user: req.user,
          })
          const base = jsonResponse(doc)
          if (previewDisabled) return base
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

        if (req.context?.[LIMITED_SCOPE] && hasDottedPath(parsedWhere)) {
          return textResponse(
            'Error: filters with a dotted path (nested or linked fields) are not available when access is limited to some collections or globals.',
          )
        }

        const summary = !select?.length && !full
        const listSelect = summary ? summaryFields(collectionConfig) : select
        const result = await req.payload.find({
          collection: collection as never,
          where: parsedWhere as never,
          depth: populateDepth(req, depth ?? 0),
          ...(listSelect?.length ? { select: toSelect(listSelect) as never } : {}),
          ...(populate ? { populate: populate as never } : {}),
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
          ...(summary
            ? {
                note: 'Summary fields only. Pass `select` for chosen fields, `full: true` for whole documents, or `documentId` to read one document in full.',
              }
            : {}),
        })

        if (previewDisabled || !collectionConfig || !draftCollections.has(collection)) return base

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
