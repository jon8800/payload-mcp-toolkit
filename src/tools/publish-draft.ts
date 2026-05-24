import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import {
  errorMessage,
  getDocDisplayName,
  requireDraftCollection,
  snapshotPublishMarker,
  stampMcpContext,
  textResponse,
  verifyPublishSucceededDespiteError,
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

      // Snapshot the doc's pre-update `updatedAt` so the recovery branch
      // below can distinguish "this attempt landed despite a post-write
      // validator throw" from "an older publish was successful and this
      // attempt did nothing" (see verifyPublishSucceededDespiteError).
      const preMarker = await snapshotPublishMarker(req, {
        kind: 'collection',
        slug: collection,
        id: documentId,
      })

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
        // Payload's update can throw a field-validation error AFTER a new
        // published version has already been written to the `_<slug>_v`
        // versions table (the validator runs in beforeChange-Fields, which
        // fires after Collection-level beforeChange hooks have already
        // mutated `data` and after the version row has been committed in
        // some draft+versions setups — see the breadcrumb self-reference
        // bug surfaced by `@payloadcms/plugin-nested-docs` on Payload v3).
        // The visible-to-the-user effect is "publish appears to fail but
        // the document is in fact live". Verify against the pre-update
        // marker before downgrading to a warning, so a stale published
        // version from a prior successful publish cannot mask a real
        // failure of the current attempt.
        const liveDoc = await verifyPublishSucceededDespiteError(
          req,
          { kind: 'collection', slug: collection, id: documentId },
          preMarker,
        )
        if (liveDoc) {
          const displayName = getDocDisplayName(liveDoc, documentId)
          // Stable token prefix lets MCP clients branch on the published-
          // with-warning state without regex-matching the prose body.
          return textResponse(
            `[publishDraft:published_with_warning] ` +
              `Published "${displayName}" in ${collection} (ID: ${documentId}) — ` +
              `but Payload reported a post-write validation error: ${errorMessage(error)}. ` +
              `The document is live; the error did not roll back the published version.`,
          )
        }
        return textResponse(
          `Error publishing document ${documentId} in ${collection}: ${errorMessage(error)}`,
        )
      }
    },
  }
}
