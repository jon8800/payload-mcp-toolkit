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
 * Custom replacement for the official plugin's update tools, which fail on
 * collections with upload fields due to a Zod schema generation bug. Uses
 * Payload's Local API directly, bypassing the problematic schema pipeline.
 */
export function createUpdateDocumentTool(
  collectionSchemas: Map<string, CollectionSchema>,
  draftCollections: Set<string>,
) {
  const updatableSlugs: string[] = []
  const descriptionLines: string[] = []
  for (const [slug, schema] of collectionSchemas) {
    if (slug === MEDIA_SLUG) continue
    updatableSlugs.push(slug)
    descriptionLines.push(`  - "${slug}": ${schema.fields.map((f) => f.name).join(', ')}`)
  }
  const collectionDescriptions = descriptionLines.join('\n')

  return {
    name: 'updateDocument',
    description:
      'Update fields on an existing document in any collection. ' +
      'Pass only the fields you want to change — unspecified fields are left untouched. ' +
      'For draft-enabled collections, updates create a new draft version (use publishDraft to make it live). ' +
      'For relationship fields, pass the related document ID (use resolveReference to find IDs). ' +
      'For upload fields, pass the media document ID (use uploadMedia to create one first).\n\n' +
      'Available collections and their fields:\n' +
      collectionDescriptions,
    parameters: {
      collection: z
        .string()
        .describe(`The collection slug. One of: ${updatableSlugs.join(', ')}`),
      documentId: z
        .string()
        .describe('The ID of the document to update'),
      data: z
        .string()
        .describe(
          'JSON string of field names to new values. Only include fields you want to change. ' +
          'Examples: \'{"title": "New Title"}\', \'{"featured": true, "category": "category-id"}\', ' +
          '\'{"tags": ["news", "update"]}\'',
        ),
    },
    handler: async (
      args: { collection: string; documentId: string; data: string },
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { collection, documentId } = args

      let data: Record<string, unknown>
      try {
        data = JSON.parse(args.data)
      } catch {
        return textResponse(
          'Error: "data" must be a valid JSON string. Example: \'{"title": "New Title"}\'',
        )
      }

      if (!collectionSchemas.has(collection)) {
        return textResponse(
          `Error: Unknown collection "${collection}". Available: ${updatableSlugs.join(', ')}`,
        )
      }

      if (collection === MEDIA_SLUG) {
        return textResponse('Error: Use the uploadMedia tool to manage media files.')
      }

      if (!data || Object.keys(data).length === 0) {
        return textResponse(
          'Error: No fields provided in "data". Pass an object with field names and values to update.',
        )
      }

      stampMcpContext(req)

      const isDraftCollection = draftCollections.has(collection)

      try {
        const doc = await req.payload.update({
          collection: collection as any,
          id: documentId,
          data: data as any,
          draft: isDraftCollection,
          req,
          overrideAccess: false,
          user: req.user,
        })

        const displayName = getDocDisplayName(doc, documentId)
        const updatedFields = Object.keys(data).join(', ')
        const draftNote = isDraftCollection ? DRAFT_NOTE : ''

        return textResponse(
          `Updated "${displayName}" in ${collection} (ID: ${documentId}). ` +
            `Changed fields: ${updatedFields}.${draftNote}`,
        )
      } catch (error) {
        return textResponse(
          `Error updating document ${documentId} in ${collection}: ${errorMessage(error)}`,
        )
      }
    },
  }
}
