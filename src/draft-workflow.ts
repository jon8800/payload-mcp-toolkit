import type { CollectionConfig, GlobalConfig } from 'payload'
import { hasCollectionDrafts, hasGlobalDrafts } from './introspection'

interface ComputeDraftCollectionsOptions {
  /** Per-collection draft behavior overrides */
  draftBehavior?: Record<string, 'always-draft' | 'always-publish'>
  /** Collection slugs to exclude from MCP entirely */
  excludeCollections?: string[]
  /** API-keys collection slug — always excluded from the MCP surface */
  apiKeysSlug?: string
}

/**
 * Determines the draft behavior for a collection.
 *
 * - No drafts configured → 'publish' (raw update allowed; no draft concept)
 * - Drafts configured + override given → use override
 * - Drafts configured + no override → 'always-draft' (raw update locked)
 */
export function getDraftBehavior(
  collection: CollectionConfig,
  options?: { draftBehavior?: Record<string, 'always-draft' | 'always-publish'> },
): 'always-draft' | 'always-publish' | 'publish' {
  if (!hasCollectionDrafts(collection)) return 'publish'

  const override = options?.draftBehavior?.[collection.slug]
  if (override) return override

  return 'always-draft'
}

export interface DraftCollectionsResult {
  /** Slugs of collections that participate in the draft workflow. */
  draftCollections: Set<string>
  /** Slugs of collections excluded from the MCP surface entirely. */
  excluded: Set<string>
}

/**
 * Walks the collection list and returns:
 *   - `draftCollections`: slugs whose `versions.drafts` is on (or whose
 *     behavior override is `'always-draft'`).
 *   - `excluded`: slugs to hide from the MCP surface entirely (the api-keys
 *     collection itself, anything with `auth: true`, anything in
 *     `excludeCollections`).
 *
 * Replaces the v0.3.x `generateMcpCollectionConfigs` shape now that the
 * toolkit owns the endpoint and tool dispatch directly — no need to produce
 * an upstream `mcpCollections` config object.
 */
export function computeDraftCollections(
  collections: CollectionConfig[],
  options: ComputeDraftCollectionsOptions = {},
): DraftCollectionsResult {
  const draftCollections = new Set<string>()
  const excluded = new Set<string>([
    options.apiKeysSlug ?? 'payload-mcp-api-keys',
    ...(options.excludeCollections ?? []),
  ])

  for (const collection of collections) {
    if (excluded.has(collection.slug)) continue

    // Auth-enabled collections are users — never expose them via MCP.
    if ((collection as { auth?: unknown }).auth) {
      excluded.add(collection.slug)
      continue
    }

    const behavior = getDraftBehavior(collection, options)
    if (behavior !== 'publish') draftCollections.add(collection.slug)
  }

  return { draftCollections, excluded }
}

interface ComputeDraftGlobalsOptions {
  /**
   * Per-resource draft behavior overrides. Shared with collections: a single
   * record may contain both collection slugs and global slugs. Collisions
   * are unambiguous in practice — Payload's slug registry forbids a global
   * and a collection sharing a slug.
   */
  draftBehavior?: Record<string, 'always-draft' | 'always-publish'>
  /** Global slugs to exclude from the MCP surface entirely */
  excludeGlobals?: string[]
}

export interface DraftGlobalsResult {
  draftGlobals: Set<string>
  excluded: Set<string>
}

/**
 * Peer of `computeDraftCollections` for globals. Returns the slugs whose
 * draft workflow is on (i.e. `versions.drafts` enabled, with optional
 * `'always-publish'` override turning it off), and the set excluded from
 * the MCP surface entirely.
 *
 * Mirrors the collection rule: `versions.drafts: true` defaults to
 * `'always-draft'` so raw publish is locked and `updateGlobal` / patch
 * routes preserve draft semantics.
 */
export function computeDraftGlobals(
  globals: GlobalConfig[],
  options: ComputeDraftGlobalsOptions = {},
): DraftGlobalsResult {
  const draftGlobals = new Set<string>()
  const excluded = new Set<string>(options.excludeGlobals ?? [])

  for (const global of globals) {
    if (excluded.has(global.slug)) continue
    if (!hasGlobalDrafts(global)) continue
    const override = options.draftBehavior?.[global.slug]
    if (override === 'always-publish') continue
    draftGlobals.add(global.slug)
  }

  return { draftGlobals, excluded }
}
