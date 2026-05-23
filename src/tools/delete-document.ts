import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import type { CollectionSchema } from '../types'
import {
  errorMessage,
  getDocDisplayName,
  stampMcpContext,
  textResponse,
} from './_helpers'

interface DeleteDocumentArgs {
  collection: string
  id: string
}

/**
 * Polymorphic, fast unsafe-delete tool. Mirrors `safeDelete`'s args but skips
 * the relationship-walk — use this when the caller knows the doc has no
 * inbound references, or when relationship breakage is acceptable.
 *
 * `safeDelete` remains the recommended default; this exists for surgical
 * deletes inside scripts and AI workflows where a relationship walk would
 * be wasteful.
 */
export function createDeleteDocumentTool(collectionSchemas: Map<string, CollectionSchema>) {
  const deletableSlugs = [...collectionSchemas.keys()]

  return {
    name: 'deleteDocument',
    routing: { kind: 'collection', action: 'delete' } as const,
    description:
      'Delete a document by ID. Skips the inbound-relationship safety check that `safeDelete` performs — use only when you know the document has no inbound references, or when broken relationships are acceptable. Prefer `safeDelete` for general use.\n\n' +
      `Collections: ${deletableSlugs.join(', ')}`,
    parameters: {
      collection: z.string().describe(`Collection slug. One of: ${deletableSlugs.join(', ')}`),
      id: z.string().describe('Document ID to delete.'),
    },
    handler: async (args: DeleteDocumentArgs, req: PayloadRequest, _extra: unknown) => {
      const { collection, id } = args

      if (!collectionSchemas.has(collection)) {
        return textResponse(
          `Error: Unknown collection "${collection}". Valid: ${deletableSlugs.join(', ')}`,
        )
      }

      stampMcpContext(req)

      try {
        const doc = await req.payload.delete({
          collection: collection as never,
          id,
          req,
          overrideAccess: false,
          user: req.user,
        })

        const displayName = getDocDisplayName(doc, id)
        return textResponse(
          `Deleted "${displayName}" from ${collection} (ID: ${id}).`,
        )
      } catch (err) {
        return textResponse(
          `Error deleting ${id} from ${collection}: ${errorMessage(err)}`,
        )
      }
    },
  }
}
