import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import type { CollectionSchema } from '../types'
import {
  DRAFT_NOTE,
  errorMessage,
  getDocDisplayName,
  stampMcpContext,
  textResponse,
} from './_helpers'

const MEDIA_SLUG = 'media'

/**
 * Custom replacement for the official plugin's `create<Resource>` tools.
 *
 * The official plugin builds its create-tool input schema by spreading
 * `convertCollectionSchemaToZod(schema).shape`, then validates the request
 * with `additionalProperties: false`. For any collection whose JSON schema
 * trips `json-schema-to-zod` (richText, upload, blocks, relationship arrays
 * — i.e. virtually every real-world content collection), the converter
 * falls back to `z.record(z.any())`, `.shape` is undefined, and the spread
 * silently produces a metadata-only schema. The MCP SDK then strips every
 * content field before it reaches `payload.create()`, so creates end up
 * with empty `data` and fail required-field validation.
 *
 * `createDocument` sidesteps the whole pipeline: take a JSON `data` string,
 * call `payload.create()` directly via the local API.
 *
 * Defaults to `draft: true` for draft-enabled collections so newly created
 * documents land in the same draft-first workflow used by `updateDocument`.
 */
export function createCreateDocumentTool(
  collectionSchemas: Map<string, CollectionSchema>,
  draftCollections: Set<string>,
) {
  const creatableSlugs: string[] = []
  const descriptionLines: string[] = []
  for (const [slug, schema] of collectionSchemas) {
    if (slug === MEDIA_SLUG) continue
    creatableSlugs.push(slug)
    descriptionLines.push(`  - "${slug}": ${schema.fields.map((f) => f.name).join(', ')}`)
  }
  const collectionDescriptions = descriptionLines.join('\n')

  return {
    name: 'createDocument',
    description:
      'Create a new document in any collection. Pass the field values as a JSON string in `data`. ' +
      'For draft-enabled collections, the document is created as a draft by default — use publishDraft to make it live, ' +
      'or pass `draft: false` to publish immediately. ' +
      'For relationship fields, pass the related document ID (use resolveReference to find IDs). ' +
      'For upload fields, pass the media document ID (use uploadMedia to create one first).\n\n' +
      'Available collections and their fields:\n' +
      collectionDescriptions,
    parameters: {
      collection: z
        .string()
        .describe(`The collection slug. One of: ${creatableSlugs.join(', ')}`),
      data: z
        .string()
        .describe(
          'JSON string of field names to values for the new document. ' +
            'Examples: \'{"name": "Aria", "slug": "aria"}\', ' +
            '\'{"title": "First-Time Clients", "heroTitle": "Welcome", "slug": "first-time-clients"}\'',
        ),
      draft: z
        .boolean()
        .optional()
        .describe(
          'Override draft status. Defaults to `true` for draft-enabled collections, `false` otherwise. ' +
            'Set explicitly to `false` on a draft-enabled collection to publish immediately.',
        ),
    },
    handler: async (
      args: { collection: string; data: string; draft?: boolean },
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { collection } = args

      let data: Record<string, unknown>
      try {
        data = JSON.parse(args.data)
      } catch {
        return textResponse(
          'Error: "data" must be a valid JSON string. Example: \'{"name": "Aria", "slug": "aria"}\'',
        )
      }

      if (!collectionSchemas.has(collection)) {
        return textResponse(
          `Error: Unknown collection "${collection}". Available: ${creatableSlugs.join(', ')}`,
        )
      }

      if (collection === MEDIA_SLUG) {
        return textResponse('Error: Use the uploadMedia tool to create media files.')
      }

      if (!data || Object.keys(data).length === 0) {
        return textResponse(
          'Error: No fields provided in "data". Pass an object with field names and values for the new document.',
        )
      }

      stampMcpContext(req)

      const isDraftCollection = draftCollections.has(collection)
      const asDraft = args.draft ?? isDraftCollection

      try {
        const doc = await req.payload.create({
          collection: collection as any,
          data: data as any,
          draft: asDraft,
          req,
          overrideAccess: false,
          user: req.user,
        })

        const displayName = getDocDisplayName(doc, String((doc as { id?: unknown }).id ?? ''))
        const newId = String((doc as { id?: unknown }).id ?? '')
        const draftNote = isDraftCollection && asDraft ? DRAFT_NOTE : ''

        return textResponse(
          `Created "${displayName}" in ${collection} (ID: ${newId}).${draftNote}`,
        )
      } catch (error) {
        return textResponse(
          `Error creating document in ${collection}: ${errorMessage(error)}`,
        )
      }
    },
  }
}
