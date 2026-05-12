import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import { errorMessage, stampMcpContext, textResponse } from './_helpers'

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
    description:
      'Publish a draft-enabled global by transitioning its _status from "draft" to "published". ' +
      `Draft-enabled globals: ${slugs.join(', ')}`,
    parameters: {
      slug: z
        .enum(slugs as [string, ...string[]])
        .describe(`The global slug. One of: ${slugs.join(', ')}`),
    },
    handler: async (args: { slug: string }, req: PayloadRequest, _extra: unknown) => {
      const { slug } = args

      if (!draftGlobals.has(slug)) {
        return textResponse(
          `Error: Global "${slug}" does not support drafts. Draft-enabled globals: ${slugs.join(', ') || 'none'}`,
        )
      }

      stampMcpContext(req)

      try {
        await req.payload.updateGlobal({
          slug: slug as never,
          data: { _status: 'published' } as never,
          req,
          overrideAccess: false,
          user: req.user,
        })
        return textResponse(`Successfully published global "${slug}".`)
      } catch (err) {
        return textResponse(`Error publishing global "${slug}": ${errorMessage(err)}`)
      }
    },
  }
}
