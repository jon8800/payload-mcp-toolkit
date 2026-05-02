import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import type { CollectionSchema } from '../types'

/**
 * Creates the schedulePublish MCP tool that stamps a future publish time
 * on a draft document.
 *
 * IMPORTANT: This tool ONLY sets `publishedAt` to a future date and keeps
 * `_status: 'draft'`. It does NOT itself flip the draft to published when
 * the time arrives. The consumer's Payload config must own the actual flip,
 * via one of:
 *
 *   1. A Payload Jobs Queue scheduled task that runs periodically and finds
 *      drafts whose `publishedAt <= now`, then calls `payload.update` with
 *      `_status: 'published'`. This is the canonical Payload-3 approach
 *      (see https://payloadcms.com/docs/jobs-queue/scheduled-jobs).
 *
 *   2. An external cron / worker that does the same query + update.
 *
 *   3. A `beforeRead` hook on the collection that resolves status on the fly.
 *
 * Without one of those, scheduled drafts remain drafts forever — the tool
 * tells the LLM exactly that in its response so the user doesn't get a
 * silent surprise.
 *
 * Skip-detects: only registered for collections that have BOTH drafts AND a
 * `publishedAt` field in their schema. Otherwise the tool is omitted entirely.
 */
export function createSchedulePublishTool(
  collectionSchemas: Map<string, CollectionSchema>,
  draftCollections: Set<string>,
): ReturnType<typeof buildTool> | null {
  const schedulableSlugs: string[] = []
  for (const slug of draftCollections) {
    const schema = collectionSchemas.get(slug)
    if (!schema) continue
    const hasPublishedAt = schema.fields.some(
      (f) => f.name === 'publishedAt' && f.type === 'date',
    )
    if (hasPublishedAt) schedulableSlugs.push(slug)
  }

  if (schedulableSlugs.length === 0) return null
  return buildTool(schedulableSlugs)
}

function buildTool(schedulableSlugs: string[]) {
  return {
    name: 'schedulePublish',
    description:
      'Schedule a draft to be published at a future date by stamping its publishedAt field. ' +
      'The document stays in draft status until your Payload jobs queue (or an external worker) ' +
      'flips it. If your project does not have a scheduled job that publishes drafts whose ' +
      'publishedAt has passed, the document will remain a draft indefinitely. ' +
      `Schedulable collections (have both drafts and a publishedAt date field): ${schedulableSlugs.join(', ')}.`,
    parameters: {
      collection: z
        .string()
        .describe(`The collection slug. One of: ${schedulableSlugs.join(', ')}`),
      documentId: z.string().describe('The ID of the draft document to schedule'),
      publishAt: z
        .string()
        .describe(
          'ISO 8601 date-time when the document should be published, e.g. "2026-06-01T09:00:00Z". ' +
          'Must be in the future.',
        ),
    },
    handler: async (
      args: { collection: string; documentId: string; publishAt: string },
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { collection, documentId, publishAt } = args

      if (!schedulableSlugs.includes(collection)) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Error: Collection "${collection}" is not schedulable. ` +
                `Schedulable collections: ${schedulableSlugs.join(', ')}. ` +
                'A collection is schedulable when it has draft support AND a date field named "publishedAt".',
            },
          ],
        }
      }

      const parsed = new Date(publishAt)
      if (isNaN(parsed.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: "${publishAt}" is not a valid ISO 8601 date-time. Example: "2026-06-01T09:00:00Z"`,
            },
          ],
        }
      }

      if (parsed.getTime() <= Date.now()) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Error: publishAt (${parsed.toISOString()}) is not in the future. ` +
                `Use the publishDraft tool to publish immediately instead.`,
            },
          ],
        }
      }

      req.context = { ...req.context, source: 'mcp' }

      try {
        const updated = await req.payload.update({
          collection: collection as any,
          id: documentId,
          data: {
            publishedAt: parsed.toISOString(),
            _status: 'draft',
          } as any,
          draft: true,
          req,
          overrideAccess: false,
          user: req.user,
        })

        const displayName =
          (updated as any).name ||
          (updated as any).title ||
          (updated as any).slug ||
          documentId

        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Scheduled "${displayName}" (${collection}#${documentId}) for publish at ${parsed.toISOString()}. ` +
                `The document will remain a draft until a scheduled job (Payload jobs queue or external worker) ` +
                `flips its _status to "published". If your project has not configured such a job, the document ` +
                `will stay a draft indefinitely — see the Payload jobs queue docs for the canonical setup.`,
            },
          ],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error scheduling ${collection}#${documentId}: ${message}`,
            },
          ],
        }
      }
    },
  }
}
