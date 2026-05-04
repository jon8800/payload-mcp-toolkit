import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import type { CollectionSchema } from '../types'
import { jsonResponse, stampMcpContext } from './_helpers'

const DEFAULT_LIMIT = 20
const HARD_LIMIT = 100

interface SearchHit {
  id: string | number
  displayName: string
  status?: string
  updatedAt?: string
  missingFields?: string[]
}

/**
 * Creates the searchContent MCP tool — natural-language filters across collections,
 * built for editor triage tasks that the official find tools don't express well.
 *
 * Examples the LLM can drive:
 *   - "all posts that are still drafts"
 *   - "pages missing a meta description"
 *   - "anything updated more than 30 days ago"
 *   - "posts by jane in the last quarter"
 *
 * Returns compact hits per collection — id, displayName, _status, updatedAt, and
 * (when missingFields was requested) which of those fields are blank on each doc.
 */
export function createSearchContentTool(
  collectionSchemas: Map<string, CollectionSchema>,
) {
  const allSlugs = [...collectionSchemas.keys()]

  return {
    name: 'searchContent',
    description:
      'Search and filter content across collections by status, age, missing fields, or free-text query. ' +
      'Designed for editor triage — finding drafts, stale content, content with missing SEO fields, etc. ' +
      `Searchable collections: ${allSlugs.join(', ')}.`,
    parameters: {
      collection: z
        .string()
        .optional()
        .describe('Restrict search to a single collection slug. Omit to search all.'),
      query: z
        .string()
        .optional()
        .describe('Free-text query matched against name/title/slug fields (case-insensitive).'),
      status: z
        .enum(['draft', 'published', 'any'])
        .optional()
        .describe(
          'Filter by draft status. "draft" or "published" only return matching docs; "any" or omitted returns all.',
        ),
      olderThanDays: z
        .number()
        .optional()
        .describe('Only docs whose updatedAt is older than this many days.'),
      newerThanDays: z
        .number()
        .optional()
        .describe('Only docs whose updatedAt is newer than this many days.'),
      missingFields: z
        .array(z.string())
        .optional()
        .describe(
          'Field names that should be empty/null. Useful for finding e.g. posts without a coverImage. ' +
          'Each hit will include a missingFields array confirming which were actually blank.',
        ),
      limit: z
        .number()
        .optional()
        .default(DEFAULT_LIMIT)
        .describe(`Maximum hits per collection (default ${DEFAULT_LIMIT}, max ${HARD_LIMIT}).`),
    },
    handler: async (
      args: {
        collection?: string
        query?: string
        status?: 'draft' | 'published' | 'any'
        olderThanDays?: number
        newerThanDays?: number
        missingFields?: string[]
        limit?: number
      },
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const {
        collection,
        query,
        status,
        olderThanDays,
        newerThanDays,
        missingFields,
        limit = DEFAULT_LIMIT,
      } = args

      stampMcpContext(req)

      const cappedLimit = Math.min(Math.max(1, limit), HARD_LIMIT)

      // When filtering by draft status, only collections that support drafts
      // are meaningful — others can't be "draft" or "published".
      const isDraftStatusFilter = status === 'draft' || status === 'published'

      let initialTargets: string[]
      if (!collection) {
        initialTargets = allSlugs
      } else if (collectionSchemas.has(collection)) {
        initialTargets = [collection]
      } else {
        initialTargets = []
      }

      const targets = isDraftStatusFilter
        ? initialTargets.filter((slug) => collectionSchemas.get(slug)?.hasDrafts)
        : initialTargets

      if (targets.length === 0) {
        return jsonResponse({
          hits: {},
          message: collection
            ? `Unknown collection "${collection}". Available: ${allSlugs.join(', ')}`
            : 'No searchable collections found.',
        })
      }

      const settled = await Promise.allSettled(
        targets.map((slug) => {
          const schema = collectionSchemas.get(slug)!
          const where = buildWhereClause(schema, {
            query,
            status,
            olderThanDays,
            newerThanDays,
            missingFields,
          })
          return req.payload.find({
            collection: slug as any,
            where: where as any,
            limit: cappedLimit,
            sort: '-updatedAt',
            depth: 0,
            // Include drafts so status='draft' works and missingFields queries
            // against draft-only collections aren't misleadingly empty.
            draft: schema.hasDrafts,
            req,
            overrideAccess: false,
            user: req.user,
          })
        }),
      )

      const grouped: Record<string, SearchHit[]> = {}
      const stats: Record<string, { totalDocs: number; returned: number }> = {}

      settled.forEach((outcome, i) => {
        if (outcome.status !== 'fulfilled') return
        const slug = targets[i]
        const result = outcome.value
        if (result.totalDocs > 0) {
          stats[slug] = { totalDocs: result.totalDocs, returned: result.docs.length }
          grouped[slug] = result.docs.map((doc: any) => buildHit(doc, missingFields))
        }
      })

      const totalHits = Object.values(grouped).reduce((sum, hits) => sum + hits.length, 0)

      return jsonResponse({ totalHits, stats, hits: grouped })
    },
  }
}

function buildHit(doc: Record<string, any>, missingFields?: string[]): SearchHit {
  const hit: SearchHit = {
    id: doc.id,
    displayName: doc.name || doc.title || doc.slug || String(doc.id),
    status: doc._status,
    updatedAt: doc.updatedAt,
  }

  if (missingFields?.length) {
    hit.missingFields = missingFields.filter((f) => isFieldEmpty(getByPath(doc, f)))
  }

  return hit
}

function getByPath(doc: Record<string, any>, path: string): unknown {
  // Walk dotted paths so `meta.description` reads doc.meta?.description rather
  // than the literal key `"meta.description"`. Matches the `where` keys we emit.
  let current: any = doc
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined
    current = current[segment]
  }
  return current
}

function isFieldEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as object).length === 0
  return false
}

interface FilterArgs {
  query?: string
  status?: 'draft' | 'published' | 'any'
  olderThanDays?: number
  newerThanDays?: number
  missingFields?: string[]
}

function buildWhereClause(schema: CollectionSchema, filters: FilterArgs): Record<string, unknown> {
  const and: Array<Record<string, unknown>> = []

  if (filters.query && schema.searchableFields.length > 0) {
    const or = schema.searchableFields.map((field) => ({
      [field]: { like: filters.query },
    }))
    and.push({ or })
  }

  // Status filter is only meaningful on draft-enabled collections
  if (filters.status && filters.status !== 'any' && schema.hasDrafts) {
    and.push({ _status: { equals: filters.status } })
  }

  if (filters.olderThanDays !== undefined) {
    const cutoff = new Date(Date.now() - filters.olderThanDays * 24 * 60 * 60 * 1000)
    and.push({ updatedAt: { less_than: cutoff.toISOString() } })
  }
  if (filters.newerThanDays !== undefined) {
    const cutoff = new Date(Date.now() - filters.newerThanDays * 24 * 60 * 60 * 1000)
    and.push({ updatedAt: { greater_than: cutoff.toISOString() } })
  }

  // Missing-field filter — express as "field is null OR field doesn't exist"
  if (filters.missingFields?.length) {
    for (const field of filters.missingFields) {
      and.push({
        or: [{ [field]: { exists: false } }, { [field]: { equals: null } }],
      })
    }
  }

  if (and.length === 0) return {}
  if (and.length === 1) return and[0]
  return { and }
}
