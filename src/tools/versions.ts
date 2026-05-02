import { z } from 'zod'
import type { PayloadRequest } from 'payload'

const DEFAULT_LIST_LIMIT = 10

/**
 * Creates the listVersions MCP tool that returns recent saved versions of a draft document.
 *
 * Only works on collections in `draftCollections`. Returns id, _status, updatedAt, and a
 * compact display name per version so an LLM can pick one to restore.
 */
export function createListVersionsTool(draftCollections: Set<string>) {
  return {
    name: 'listVersions',
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
      args: { collection: string; documentId: string; limit?: number },
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { collection, documentId, limit = DEFAULT_LIST_LIMIT } = args

      if (!draftCollections.has(collection)) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Error: Collection "${collection}" does not support versions. ` +
                `Draft-enabled collections: ${[...draftCollections].join(', ') || 'none'}`,
            },
          ],
        }
      }

      req.context = { ...req.context, source: 'mcp' }

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
            displayName:
              snapshot.name ||
              snapshot.title ||
              snapshot.slug ||
              `${collection}#${documentId}`,
            autosave: v.autosave === true,
          }
        })

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                collection,
                documentId,
                totalDocs: result.totalDocs,
                returned: versions.length,
                versions,
              }),
            },
          ],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing versions for ${collection}#${documentId}: ${message}`,
            },
          ],
        }
      }
    },
  }
}

/**
 * Creates the restoreVersion MCP tool that rolls a document back to a saved version.
 *
 * Restoring a version creates a new version on top — the old current state is preserved
 * so the operation is itself reversible via another restore.
 */
export function createRestoreVersionTool(draftCollections: Set<string>) {
  return {
    name: 'restoreVersion',
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
      args: { collection: string; versionId: string },
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { collection, versionId } = args

      if (!draftCollections.has(collection)) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Error: Collection "${collection}" does not support versions. ` +
                `Draft-enabled collections: ${[...draftCollections].join(', ') || 'none'}`,
            },
          ],
        }
      }

      req.context = { ...req.context, source: 'mcp' }

      try {
        const restored = await req.payload.restoreVersion({
          collection: collection as any,
          id: versionId,
          req,
          overrideAccess: false,
          user: req.user,
        })

        const displayName =
          (restored as any).name ||
          (restored as any).title ||
          (restored as any).slug ||
          (restored as any).id

        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Restored ${collection} document "${displayName}" (ID: ${(restored as any).id}) ` +
                `from version ${versionId}. The document is now in draft status — ` +
                `use publishDraft to make the restored content live.`,
            },
          ],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error restoring ${collection} from version ${versionId}: ${message}`,
            },
          ],
        }
      }
    },
  }
}
