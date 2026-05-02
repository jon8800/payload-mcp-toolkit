import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import type { CollectionSchema } from '../types'

/**
 * Creates the updateDocument MCP tool that updates fields on an existing document.
 *
 * This is a custom replacement for the official plugin's update tools, which
 * fail on collections with upload fields due to a Zod schema generation bug.
 * Uses Payload's Local API directly, bypassing the problematic schema pipeline.
 *
 * @param collectionSchemas - Introspected collection schemas for validation and description
 * @param draftCollections - Set of collection slugs that support drafts
 */
export function createUpdateDocumentTool(
  collectionSchemas: Map<string, CollectionSchema>,
  draftCollections: Set<string>,
) {
  const updatableSlugs = [...collectionSchemas.keys()].filter(
    (slug) => slug !== 'media',
  )

  const collectionDescriptions = updatableSlugs
    .map((slug) => {
      const schema = collectionSchemas.get(slug)!
      const fieldNames = schema.fields.map((f) => f.name).join(', ')
      return `  - "${slug}": ${fieldNames}`
    })
    .join('\n')

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
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: "data" must be a valid JSON string. Example: \'{"title": "New Title"}\'',
            },
          ],
        }
      }

      if (!collectionSchemas.has(collection)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Unknown collection "${collection}". ` +
                `Available: ${updatableSlugs.join(', ')}`,
            },
          ],
        }
      }

      if (collection === 'media') {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Use the uploadMedia tool to manage media files.',
            },
          ],
        }
      }

      if (!data || Object.keys(data).length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: No fields provided in "data". Pass an object with field names and values to update.',
            },
          ],
        }
      }

      req.context = { ...req.context, source: 'mcp' }

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

        const displayName =
          (doc as any).name ||
          (doc as any).title ||
          (doc as any).slug ||
          documentId

        const updatedFields = Object.keys(data).join(', ')
        const draftNote = isDraftCollection
          ? ` Document is in draft status — use publishDraft to make it live.`
          : ''

        return {
          content: [
            {
              type: 'text' as const,
              text: `Updated "${displayName}" in ${collection} (ID: ${documentId}). ` +
                `Changed fields: ${updatedFields}.${draftNote}`,
            },
          ],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error updating document ${documentId} in ${collection}: ${message}`,
            },
          ],
        }
      }
    },
  }
}
