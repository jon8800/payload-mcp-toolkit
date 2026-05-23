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
      locale: z
        .string()
        .optional()
        .describe('Optional locale code (e.g. "en", "fr") to filter version snapshots to.'),
    },
    handler: async (
      args: Record<string, unknown>,
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { slug, limit = DEFAULT_LIST_LIMIT, locale } = args as {
        slug: string
        limit?: number
        locale?: string
      }

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
          ...(locale ? { locale: locale as never } : {}),
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
      expectedUpdatedAt: z
        .string()
        .optional()
        .describe(
          'Optional CAS guard. If set, the restore is rejected when the global\'s current updatedAt differs from this value — protects against clobbering concurrent edits. Pass the updatedAt returned by a prior findGlobal call.',
        ),
      locale: z
        .string()
        .optional()
        .describe('Optional locale code (e.g. "en", "fr") to scope the restore to a single locale.'),
    },
    handler: async (
      args: Record<string, unknown>,
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { slug, versionId, expectedUpdatedAt, locale } = args as {
        slug: string
        versionId: string
        expectedUpdatedAt?: string
        locale?: string
      }

      if (!draftGlobals.has(slug)) {
        return textResponse(
          `Error: Global "${slug}" does not support versions. Draft-enabled globals: ${slugs.join(', ') || 'none'}`,
        )
      }

      stampMcpContext(req)

      if (expectedUpdatedAt !== undefined) {
        try {
          const current = (await req.payload.findGlobal({
            slug: slug as never,
            depth: 0,
            draft: true,
            ...(locale ? { locale: locale as never } : {}),
            req,
            overrideAccess: false,
            user: req.user,
          })) as { updatedAt?: unknown } | undefined
          const currentUpdatedAt = current?.updatedAt
          const currentStr =
            typeof currentUpdatedAt === 'string'
              ? currentUpdatedAt
              : currentUpdatedAt instanceof Date
                ? currentUpdatedAt.toISOString()
                : undefined
          if (currentStr !== expectedUpdatedAt) {
            return textResponse(
              `Conflict: global "${slug}" was modified since expectedUpdatedAt (${expectedUpdatedAt}); current updatedAt is ${currentStr ?? 'unknown'}. Re-read the global and retry.`,
            )
          }
        } catch (err) {
          return textResponse(
            `Error checking expectedUpdatedAt on global "${slug}": ${errorMessage(err)}`,
          )
        }
      }

      try {
        await req.payload.restoreGlobalVersion({
          slug: slug as never,
          id: versionId,
          ...(locale ? { locale: locale as never } : {}),
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
