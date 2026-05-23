import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import {
  errorMessage,
  getDocDisplayName,
  jsonResponse,
  requireDraftCollection,
  stampMcpContext,
  textResponse,
} from './_helpers'

const DEFAULT_LIST_LIMIT = 10

/**
 * Lists recent saved versions of a draft document. Returns id, _status,
 * updatedAt, and a compact display name per version so an LLM can pick one
 * to restore.
 */
export function createListVersionsTool(draftCollections: Set<string>) {
  return {
    name: 'listVersions',
    routing: { kind: 'collection', action: 'read' } as const,
    description:
      'List recent saved versions of a document on a draft-enabled collection. ' +
      'Use before restoreVersion to pick the right point in time. ' +
      `Draft-enabled collections: ${[...draftCollections].join(', ') || 'none'}`,
    parameters: {
      collection: z
        .string()
        .describe(
          `The collection slug. Must be one of: ${[...draftCollections].join(', ') || 'none'}`,
        ),
      documentId: z.string().describe('The ID of the document whose versions you want to list'),
      limit: z
        .number()
        .optional()
        .default(DEFAULT_LIST_LIMIT)
        .describe(`Maximum number of versions to return (default ${DEFAULT_LIST_LIMIT})`),
    },
    handler: async (
      args: Record<string, unknown>,
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { collection, documentId, limit = DEFAULT_LIST_LIMIT } = args as {
        collection: string
        documentId: string
        limit?: number
      }

      const guard = requireDraftCollection(collection, draftCollections, 'versions')
      if (guard) return guard

      stampMcpContext(req)

      try {
        const result = await req.payload.findVersions({
          collection: collection as any,
          where: { parent: { equals: documentId } },
          sort: '-updatedAt',
          limit,
          req,
          overrideAccess: false,
          user: req.user,
        })

        const versions = result.docs.map((v: any) => {
          const snapshot = v.version || {}
          return {
            id: v.id,
            updatedAt: v.updatedAt,
            createdAt: v.createdAt,
            status: snapshot._status ?? 'unknown',
            displayName: getDocDisplayName(snapshot, `${collection}#${documentId}`),
            autosave: v.autosave === true,
          }
        })

        return jsonResponse({
          collection,
          documentId,
          totalDocs: result.totalDocs,
          returned: versions.length,
          versions,
        })
      } catch (error) {
        return textResponse(
          `Error listing versions for ${collection}#${documentId}: ${errorMessage(error)}`,
        )
      }
    },
  }
}

/**
 * Restoring a version creates a new version on top — the previous current
 * state is preserved so the operation is itself reversible.
 */
export function createRestoreVersionTool(draftCollections: Set<string>) {
  return {
    name: 'restoreVersion',
    routing: { kind: 'collection', action: 'update' } as const,
    description:
      'Restore a document to a previously saved version. ' +
      'Use listVersions first to find the version ID. ' +
      'Restoring creates a new version on top, so the previous current state is also recoverable. ' +
      `Draft-enabled collections: ${[...draftCollections].join(', ') || 'none'}`,
    parameters: {
      collection: z
        .string()
        .describe(
          `The collection slug. Must be one of: ${[...draftCollections].join(', ') || 'none'}`,
        ),
      versionId: z
        .string()
        .describe('The version ID returned by listVersions (NOT the document ID)'),
    },
    handler: async (
      args: Record<string, unknown>,
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { collection, versionId } = args as { collection: string; versionId: string }

      const guard = requireDraftCollection(collection, draftCollections, 'versions')
      if (guard) return guard

      stampMcpContext(req)

      try {
        const restored = await req.payload.restoreVersion({
          collection: collection as any,
          id: versionId,
          req,
          overrideAccess: false,
          user: req.user,
        })

        const restoredId = String((restored as any).id)
        const displayName = getDocDisplayName(restored, restoredId)

        return textResponse(
          `Restored ${collection} document "${displayName}" (ID: ${restoredId}) ` +
            `from version ${versionId}. The document is now in draft status — ` +
            `use publishDraft to make the restored content live.`,
        )
      } catch (error) {
        return textResponse(
          `Error restoring ${collection} from version ${versionId}: ${errorMessage(error)}`,
        )
      }
    },
  }
}
