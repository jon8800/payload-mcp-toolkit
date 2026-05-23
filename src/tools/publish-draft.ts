import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import {
  errorMessage,
  getDocDisplayName,
  requireDraftCollection,
  stampMcpContext,
  textResponse,
} from './_helpers'

export function createPublishDraftTool(draftCollections: Set<string>) {
  return {
    name: 'publishDraft',
    routing: { kind: 'collection', action: 'update' } as const,
    description:
      'Publish a draft document by transitioning its _status from "draft" to "published". ' +
      'Only works on collections that support drafts. Use after creating or editing content ' +
      'to make it live on the site.',
    parameters: {
      collection: z
        .string()
        .describe(
          `The collection slug. Draft-enabled collections: ${[...draftCollections].join(', ') || 'none'}`,
        ),
      documentId: z.string().describe('The ID of the document to publish'),
    },
    handler: async (
      rawArgs: Record<string, unknown>,
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const args = rawArgs as { collection: string; documentId: string }
      const { collection, documentId } = args

      const guard = requireDraftCollection(collection, draftCollections)
      if (guard) return guard

      stampMcpContext(req)

      try {
        const doc = await req.payload.update({
          collection: collection as any,
          id: documentId,
          data: { _status: 'published' } as any,
          req,
          overrideAccess: false,
          user: req.user,
        })

        const displayName = getDocDisplayName(doc, documentId)
        return textResponse(
          `Successfully published "${displayName}" in ${collection} (ID: ${documentId}).`,
        )
      } catch (error) {
        return textResponse(
          `Error publishing document ${documentId} in ${collection}: ${errorMessage(error)}`,
        )
      }
    },
  }
}
