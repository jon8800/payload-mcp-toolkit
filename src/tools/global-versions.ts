import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import { errorMessage, jsonResponse, stampMcpContext, textResponse } from './_helpers'

const DEFAULT_LIST_LIMIT = 10

/**
 * List recent saved versions of a draft-enabled global. Returns null when no
 * global has drafts enabled so the plugin entry can skip registration.
 */
export function createListGlobalVersionsTool(draftGlobals: Set<string>) {
  if (draftGlobals.size === 0) return null

  const slugs = [...draftGlobals]
  return {
    name: 'listGlobalVersions',
    routing: { kind: 'global', action: 'read' } as const,
    description:
      'List recent saved versions of a draft-enabled global. ' +
      'Use before restoreGlobalVersion to pick the right point in time. ' +
      `Draft-enabled globals: ${slugs.join(', ')}`,
    parameters: {
      slug: z
        .enum(slugs as [string, ...string[]])
        .describe(`The global slug. One of: ${slugs.join(', ')}`),
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
      const { slug, limit = DEFAULT_LIST_LIMIT } = args as { slug: string; limit?: number }

      if (!draftGlobals.has(slug)) {
        return textResponse(
          `Error: Global "${slug}" does not support versions. Draft-enabled globals: ${slugs.join(', ') || 'none'}`,
        )
      }

      stampMcpContext(req)

      try {
        const result = await req.payload.findGlobalVersions({
          slug: slug as never,
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
            autosave: v.autosave === true,
          }
        })

        return jsonResponse({
          slug,
          totalDocs: result.totalDocs,
          returned: versions.length,
          versions,
        })
      } catch (err) {
        return textResponse(`Error listing versions for global "${slug}": ${errorMessage(err)}`)
      }
    },
  }
}

/**
 * Restore a draft-enabled global to a previously saved version. Returns null
 * when no global has drafts enabled.
 */
export function createRestoreGlobalVersionTool(draftGlobals: Set<string>) {
  if (draftGlobals.size === 0) return null

  const slugs = [...draftGlobals]
  return {
    name: 'restoreGlobalVersion',
    routing: { kind: 'global', action: 'update' } as const,
    description:
      'Restore a global to a previously saved version. ' +
      'Use listGlobalVersions first to find the version ID. ' +
      'Restoring creates a new version on top, so the previous state is recoverable. ' +
      `Draft-enabled globals: ${slugs.join(', ')}`,
    parameters: {
      slug: z
        .enum(slugs as [string, ...string[]])
        .describe(`The global slug. One of: ${slugs.join(', ')}`),
      versionId: z
        .string()
        .describe('The version ID returned by listGlobalVersions (NOT the global slug)'),
    },
    handler: async (
      args: Record<string, unknown>,
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { slug, versionId } = args as { slug: string; versionId: string }

      if (!draftGlobals.has(slug)) {
        return textResponse(
          `Error: Global "${slug}" does not support versions. Draft-enabled globals: ${slugs.join(', ') || 'none'}`,
        )
      }

      stampMcpContext(req)

      try {
        await req.payload.restoreGlobalVersion({
          slug: slug as never,
          id: versionId,
          req,
          overrideAccess: false,
          user: req.user,
        })
        return textResponse(
          `Restored global "${slug}" from version ${versionId}. ` +
            `The global is now in draft status — use publishGlobalDraft to make the restored content live.`,
        )
      } catch (err) {
        return textResponse(
          `Error restoring global "${slug}" from version ${versionId}: ${errorMessage(err)}`,
        )
      }
    },
  }
}
