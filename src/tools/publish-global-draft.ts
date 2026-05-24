import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import {
  errorMessage,
  slugEnum,
  snapshotPublishMarker,
  stampMcpContext,
  textResponse,
  verifyPublishSucceededDespiteError,
} from './_helpers'

/**
 * Promote a draft-enabled global's pending draft to published. Mirrors
 * publishDraft for collections. Returns null when no global has drafts
 * enabled so the plugin entry can skip registration.
 */
export function createPublishGlobalDraftTool(draftGlobals: Set<string>) {
  if (draftGlobals.size === 0) return null

  const slugs = [...draftGlobals]
  return {
    name: 'publishGlobalDraft',
    routing: { kind: 'global', action: 'update' } as const,
    description:
      'Publish a draft-enabled global by transitioning its _status from "draft" to "published". ' +
      `Draft-enabled globals: ${slugs.join(', ')}`,
    parameters: {
      slug: slugEnum(slugs, 'global').describe(`The global slug. One of: ${slugs.join(', ')}`),
      locale: z
        .string()
        .optional()
        .describe('Optional locale code (e.g. "en", "fr") for the publish operation.'),
    },
    handler: async (args: Record<string, unknown>, req: PayloadRequest, _extra: unknown) => {
      const { slug, locale } = args as { slug: string; locale?: string }

      if (!draftGlobals.has(slug)) {
        return textResponse(
          `Error: Global "${slug}" does not support drafts. Draft-enabled globals: ${slugs.join(', ') || 'none'}`,
        )
      }

      stampMcpContext(req)

      // Capture pre-update marker so the recovery branch below can
      // distinguish a publish that landed despite a post-write throw from
      // a pre-existing published version inherited from an earlier
      // successful publish.
      const preMarker = await snapshotPublishMarker(req, {
        kind: 'global',
        slug,
        ...(locale ? { locale } : {}),
      })

      try {
        // `slug as never` / `locale as never`: Payload's updateGlobal /
        // findGlobal generic narrows the slug to a TConfig-derived literal
        // union we cannot satisfy with a runtime-supplied string.
        await req.payload.updateGlobal({
          slug: slug as never,
          data: { _status: 'published' } as never,
          ...(locale ? { locale: locale as never } : {}),
          req,
          overrideAccess: false,
          user: req.user,
        })
        return textResponse(`Successfully published global "${slug}".`)
      } catch (err) {
        // Mirror publishDraft's recovery (see publish-draft.ts for the
        // longer note on the post-write validator throw). The shared
        // helper enforces the strictly-newer `updatedAt` check, so a
        // pre-existing published row from an earlier publish cannot mask
        // a real failure of the current attempt.
        const liveGlobal = await verifyPublishSucceededDespiteError(
          req,
          { kind: 'global', slug, ...(locale ? { locale } : {}) },
          preMarker,
        )
        if (liveGlobal) {
          return textResponse(
            `[publishGlobalDraft:published_with_warning] ` +
              `Published global "${slug}" — but Payload reported a post-write validation error: ` +
              `${errorMessage(err)}. The global is live; the error did not roll back the ` +
              `published version.`,
          )
        }
        return textResponse(`Error publishing global "${slug}": ${errorMessage(err)}`)
      }
    },
  }
}
