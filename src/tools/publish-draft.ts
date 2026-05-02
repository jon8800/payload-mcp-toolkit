import { z } from 'zod'
import type { PayloadRequest } from 'payload'

/**
 * Creates the publishDraft MCP tool that transitions a document from draft to published status.
 *
 * @param draftCollections - Set of collection slugs that support drafts
 */
export function createPublishDraftTool(draftCollections: Set<string>) {
  return {
    name: 'publishDraft',
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
      args: { collection: string; documentId: string },
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { collection, documentId } = args

      if (!draftCollections.has(collection)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Collection "${collection}" does not support drafts. ` +
                `Draft-enabled collections: ${[...draftCollections].join(', ') || 'none'}`,
            },
          ],
        }
      }

      req.context = { ...req.context, source: 'mcp' }

      try {
        const doc = await req.payload.update({
          collection: collection as any,
          id: documentId,
          data: { _status: 'published' } as any,
          req,
          overrideAccess: false,
          user: req.user,
        })

        const displayName =
          (doc as any).name ||
          (doc as any).title ||
          (doc as any).slug ||
          documentId

        return {
          content: [
            {
              type: 'text' as const,
              text: `Successfully published "${displayName}" in ${collection} (ID: ${documentId}).`,
            },
          ],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error publishing document ${documentId} in ${collection}: ${message}`,
            },
          ],
        }
      }
    },
  }
}
