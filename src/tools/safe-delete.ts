import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import type { RelationshipEdge } from '../types'
import { errorMessage, jsonResponse, stampMcpContext, textResponse } from './_helpers'

const SAMPLE_LIMIT = 5

interface InboundReference {
  fromCollection: string
  fieldName: string
  count: number
  sampleIds: (string | number)[]
}

interface ReverseEdge {
  fromCollection: string
  fieldName: string
  hasMany: boolean
}

/**
 * safeDelete wraps the official delete operation with a relationship-graph
 * pre-check.
 *
 * Workflow:
 * 1. Use the introspected relationshipGraph to find every (collection, field)
 *    pair that points TO the target collection.
 * 2. For each, query for documents that reference the target ID. Aggregate
 *    counts and a small sample of inbound document IDs.
 * 3. If any inbound references exist and `confirm` is false, refuse and
 *    return the impact summary so the caller can decide.
 * 4. Otherwise, perform the delete.
 *
 * Excludes built-in Payload bookkeeping collections from the inbound search.
 */
export function createSafeDeleteTool(relationships: RelationshipEdge[]) {
  // reverseIndex: target collection slug → edges that reference it
  const reverseIndex = new Map<string, ReverseEdge[]>()
  for (const edge of relationships) {
    const targets = Array.isArray(edge.toCollection) ? edge.toCollection : [edge.toCollection]
    for (const target of targets) {
      if (!reverseIndex.has(target)) reverseIndex.set(target, [])
      reverseIndex.get(target)!.push({
        fromCollection: edge.fromCollection,
        fieldName: edge.fieldName,
        hasMany: edge.hasMany,
      })
    }
  }

  return {
    name: 'safeDelete',
    routing: { kind: 'collection', action: 'delete' } as const,
    description:
      'Delete a document only after checking for inbound relationships. ' +
      'If other documents reference the target, the delete is refused unless `confirm` is true. ' +
      'Use this in preference to the raw delete tools when removing entities that other content might depend on ' +
      '(authors, categories, media, locations, etc.). Returns the impact summary either way.',
    parameters: {
      collection: z.string().describe('Slug of the collection containing the document to delete'),
      documentId: z.string().describe('ID of the document to delete'),
      confirm: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'If false (default), refuse to delete when inbound references exist and return the impact summary. ' +
          'Pass true to delete anyway after reviewing the impact.',
        ),
    },
    handler: async (
      rawArgs: Record<string, unknown>,
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const args = rawArgs as { collection: string; documentId: string; confirm?: boolean }
      const { collection, documentId, confirm = false } = args

      stampMcpContext(req)

      const inboundEdges = (reverseIndex.get(collection) ?? []).filter(
        (edge) => !edge.fromCollection.startsWith('payload-'),
      )

      const settled = await Promise.allSettled(
        inboundEdges.map((edge) =>
          req.payload.find({
            collection: edge.fromCollection as any,
            where: { [edge.fieldName]: { equals: documentId } } as any,
            limit: SAMPLE_LIMIT,
            select: { id: true } as any,
            // CRITICAL: include drafts. Without this, a draft document
            // referencing the target is invisible to the safety check and
            // the delete is allowed through — exactly the failure mode this
            // tool is supposed to prevent.
            draft: true,
            req,
            overrideAccess: false,
            user: req.user,
          }),
        ),
      )

      const references: InboundReference[] = []
      const failedEdges: { fromCollection: string; fieldName: string; error: string }[] = []

      settled.forEach((outcome, i) => {
        const edge = inboundEdges[i]
        if (outcome.status === 'rejected') {
          // Fail closed: an unverified edge means we don't know whether the
          // target is referenced. Refuse the delete unless the caller opts in.
          failedEdges.push({
            fromCollection: edge.fromCollection,
            fieldName: edge.fieldName,
            error: errorMessage(outcome.reason),
          })
          return
        }
        const result = outcome.value
        if (result.totalDocs > 0) {
          references.push({
            fromCollection: edge.fromCollection,
            fieldName: edge.fieldName,
            count: result.totalDocs,
            sampleIds: result.docs.map((d: any) => d.id),
          })
        }
      })

      if (failedEdges.length > 0 && !confirm) {
        return jsonResponse({
          success: false,
          refused: true,
          message:
            `Refusing to delete ${collection}#${documentId}: could not verify ` +
            `${failedEdges.length} inbound reference path(s). Pass confirm=true to delete anyway.`,
          unverifiedEdges: failedEdges,
        })
      }

      const totalReferences = references.reduce((sum, r) => sum + r.count, 0)

      if (totalReferences > 0 && !confirm) {
        return jsonResponse({
          success: false,
          refused: true,
          message:
            `Refusing to delete ${collection}#${documentId}: ${totalReferences} inbound reference(s) ` +
            `found across ${references.length} field path(s). Pass confirm=true to delete anyway.`,
          totalReferences,
          references,
        })
      }

      try {
        await req.payload.delete({
          collection: collection as any,
          id: documentId,
          req,
          overrideAccess: false,
          user: req.user,
        })

        return jsonResponse({
          success: true,
          message:
            totalReferences > 0
              ? `Deleted ${collection}#${documentId} despite ${totalReferences} inbound reference(s) (confirm=true).`
              : `Deleted ${collection}#${documentId}. No inbound references were found.`,
          totalReferences,
          references,
        })
      } catch (error) {
        return textResponse(
          `Error deleting ${collection}#${documentId}: ${errorMessage(error)}`,
        )
      }
    },
  }
}
