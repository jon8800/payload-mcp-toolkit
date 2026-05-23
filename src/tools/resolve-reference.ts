import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import { jsonResponse, stampMcpContext } from './_helpers'

interface MatchCandidate {
  collection: string
  id: string | number
  displayName: string
  matchedField: string
  matchType: 'exact-slug' | 'exact' | 'partial'
}

export function createResolveReferenceTool(
  searchableCollections: Map<string, string[]>,
) {
  return {
    name: 'resolveReference',
    routing: { kind: 'account', action: 'read' } as const,
    description:
      'Search for documents across collections by name, title, or slug. ' +
      'Returns ranked candidates with IDs for use in relationship fields. ' +
      'Optionally filter to a specific collection.',
    parameters: z.object({
      query: z.string().describe('Search term to match against name, title, or slug fields'),
      collection: z
        .string()
        .optional()
        .describe('Optional collection slug to restrict search to a single collection'),
    }),
    handler: async (args: { query: string; collection?: string }, req: PayloadRequest) => {
      stampMcpContext(req)

      const { query, collection } = args

      const collectionsToSearch = collection
        ? new Map(
            searchableCollections.has(collection)
              ? [[collection, searchableCollections.get(collection)!]]
              : [],
          )
        : searchableCollections

      if (collectionsToSearch.size === 0) {
        const available = Array.from(searchableCollections.keys()).join(', ')
        return jsonResponse({
          candidates: [],
          message: collection
            ? `Collection "${collection}" has no searchable fields or does not exist. Available searchable collections: ${available}`
            : 'No searchable collections found.',
        })
      }

      const targets = Array.from(collectionsToSearch.entries()).filter(
        ([, fields]) => fields.length > 0,
      )

      const settled = await Promise.allSettled(
        targets.map(([slug, fields]) => {
          const selectFields: Record<string, true> = {}
          for (const field of fields) selectFields[field] = true
          return req.payload.find({
            collection: slug as any,
            where: { or: fields.map((field) => ({ [field]: { like: query } })) },
            limit: 5,
            select: selectFields,
            req,
            overrideAccess: false,
            user: req.user,
          })
        }),
      )

      const allCandidates: MatchCandidate[] = []
      settled.forEach((outcome, i) => {
        if (outcome.status !== 'fulfilled') return
        const [slug, fields] = targets[i]
        for (const doc of outcome.value.docs) {
          allCandidates.push(...rankDocument(doc, slug, fields, query))
        }
      })

      allCandidates.sort(
        (a, b) => matchTypePriority(a.matchType) - matchTypePriority(b.matchType),
      )

      if (allCandidates.length === 0) {
        const searched = Array.from(collectionsToSearch.keys()).join(', ')
        const available = Array.from(searchableCollections.keys()).join(', ')
        return jsonResponse({
          candidates: {},
          message: `No results found for "${query}" in: ${searched}. Try a different spelling or search term. All searchable collections: ${available}`,
        })
      }

      const grouped: Record<string, Omit<MatchCandidate, 'collection'>[]> = {}
      for (const candidate of allCandidates) {
        const { collection: col, ...rest } = candidate
        if (!grouped[col]) grouped[col] = []
        grouped[col].push(rest)
      }

      return jsonResponse({
        candidates: grouped,
        total: allCandidates.length,
      })
    },
  }
}

function rankDocument(
  doc: Record<string, any>,
  collection: string,
  fields: string[],
  query: string,
): MatchCandidate[] {
  const queryLower = query.toLowerCase()
  let bestMatch: MatchCandidate | null = null

  for (const field of fields) {
    const value = doc[field]
    if (typeof value !== 'string') continue

    const valueLower = value.toLowerCase()
    let matchType: MatchCandidate['matchType']

    if (field === 'slug' && valueLower === queryLower) {
      matchType = 'exact-slug'
    } else if (valueLower === queryLower) {
      matchType = 'exact'
    } else {
      matchType = 'partial'
    }

    if (
      !bestMatch ||
      matchTypePriority(matchType) < matchTypePriority(bestMatch.matchType)
    ) {
      bestMatch = {
        collection,
        id: doc.id,
        displayName: getDisplayName(doc, fields),
        matchedField: field,
        matchType,
      }
    }
  }

  return bestMatch ? [bestMatch] : []
}

function matchTypePriority(type: MatchCandidate['matchType']): number {
  switch (type) {
    case 'exact-slug':
      return 0
    case 'exact':
      return 1
    case 'partial':
      return 2
  }
}

function getDisplayName(doc: Record<string, any>, fields: string[]): string {
  for (const preferred of ['name', 'title', 'slug']) {
    if (fields.includes(preferred) && typeof doc[preferred] === 'string') {
      return doc[preferred]
    }
  }
  return String(doc.id)
}
