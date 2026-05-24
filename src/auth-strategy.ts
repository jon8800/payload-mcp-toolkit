import type { AuthStrategy, PayloadRequest, Where } from 'payload'
import { extractBearerToken, hashKey } from './hash'
import type { CollectionAction, GlobalAction, KeyScopes, ScopePreset } from './types'

export type { CollectionAction, GlobalAction, KeyScopes, ScopePreset } from './types'

export const AUTH_STRATEGY_NAME = 'mcp-toolkit-bearer'

export interface CreateBearerStrategyOptions {
  /** Slug of the API-keys collection (defaults to `payload-mcp-api-keys`). */
  collectionSlug: string
  /** Slug of the user collection that API keys link to. */
  userCollection: string
}

/**
 * Stored shape for a row in `collectionScopes` / `globalScopes` (v0.6+).
 * The parent field name encodes the axis — collection-vs-global is not
 * repeated in the row payload. Legacy `collection` / `global` keys from
 * pre-0.6 rows are tolerated by `composeScopes` for one release; v0.7
 * drops the fallback (see CHANGELOG).
 */
interface ScopeRow {
  slug?: unknown
  /** @deprecated pre-0.6 collectionScopes shape — read via fallback only. */
  collection?: unknown
  /** @deprecated pre-0.6 globalScopes shape — read via fallback only. */
  global?: unknown
  actions?: unknown
}

interface ApiKeyRow {
  id: string | number
  user: unknown
  preset?: ScopePreset | 'custom' | null
  collectionScopes?: ScopeRow[] | null
  globalScopes?: ScopeRow[] | null
  toolAllow?: string[] | null
  toolDeny?: string[] | null
  expiresAt?: string | Date | null
  revokedAt?: string | Date | null
  apiKey?: string | null
  keyPrefix?: string | null
}

/**
 * Reads the row's slug, tolerating the pre-0.6 `collection` / `global`
 * keys for one release. Logs a one-line warn when the legacy fallback
 * fires so operators can spot keys that need re-saving. The fallback is
 * scheduled for removal in v0.7.
 */
let warnedLegacyShape = false
let warnedLegacyNonCustomOverride = false

/** @internal test-only: reset the one-time legacy warns. */
export function _resetLegacyWarnsForTests(): void {
  warnedLegacyShape = false
  warnedLegacyNonCustomOverride = false
}

function readScopeSlug(
  entry: ScopeRow,
  legacyKey: 'collection' | 'global',
  logger?: { warn?: (...args: unknown[]) => void } | undefined,
): string | null {
  if (typeof entry?.slug === 'string') return entry.slug
  const legacy = entry?.[legacyKey]
  if (typeof legacy === 'string') {
    if (!warnedLegacyShape) {
      warnedLegacyShape = true
      logger?.warn?.(
        { event: 'mcp.auth.legacy_scope_shape', legacyKey },
        `[payload-mcp-toolkit] composeScopes read a pre-0.6 row using \`${legacyKey}\`; resave the API key to migrate to {slug, actions}. The fallback is removed in v0.7.`,
      )
    }
    return legacy
  }
  return null
}

const VALID_ACTIONS: ReadonlySet<CollectionAction> = new Set(['read', 'create', 'update', 'delete'])
const VALID_GLOBAL_ACTIONS: ReadonlySet<GlobalAction> = new Set(['read', 'update'])

/**
 * Builds the runtime `KeyScopes` shape consumed by `registry.assertScopeAllows`
 * from the typed scope fields on the api-key row.
 *
 * Returns null when no typed fields are populated AND no preset is set
 * (= full access — back-compat for pre-0.5 rows that pre-date scoped authz).
 *
 * Two complementary fail-closed rules:
 *
 * 1. **`'custom'` deny-all sentinel.** `'custom'` is a UI sentinel meaning
 *    "use my override fields"; it never becomes `KeyScopes.preset` itself.
 *    Payload persists unset JSON / select fields as `null`, so a fresh
 *    Custom key with no overrides arrives as `{preset:'custom',
 *    collectionScopes:null, globalScopes:null, toolAllow:null,
 *    toolDeny:null}`. That row must deny everything (not fall through to
 *    full access). The sentinel emits `{collections:{}, globals:{},
 *    tools:{allow:[]}}`.
 *
 * 2. **Per-axis explicit-empty, Custom-only.** Under the Custom preset, an
 *    empty array on any axis (even `[]`) is honoured as written — an empty
 *    `toolAllow:[]` means "deny all tools on this axis", not "no opinion".
 *    Under non-Custom presets, empty arrays are IGNORED because Payload's
 *    hasMany / unpopulated-JSON reads return `[]` for fields the user
 *    never touched (the override matrices are hidden in the admin UI under
 *    non-Custom presets via `condition: isCustomPreset`). The on-write
 *    counterpart of this rule lives in `createApiKeysCollection`'s
 *    `beforeValidate` hook, which proactively nulls the override axes on
 *    save when the preset is non-Custom — both layers must stay in sync.
 *    Non-empty arrays still apply as layered narrowing under any preset.
 *    `toolDeny` is a deny-list, so an empty array carries no entries — it
 *    is dropped rather than emitted. NOTE: legacy non-Custom rows persisted
 *    BEFORE v0.7.1 with populated stale override arrays continue to narrow
 *    on read until each row is manually re-saved; the on-write fix only
 *    applies to fresh writes.
 */
export function composeScopes(
  row: ApiKeyRow,
  logger?: { warn?: (...args: unknown[]) => void },
): KeyScopes | null {
  const presetRaw = row.preset
  const hasPreset = typeof presetRaw === 'string' && presetRaw.length > 0
  const hasCollectionScopesField = Array.isArray(row.collectionScopes)
  const hasGlobalScopesField = Array.isArray(row.globalScopes)
  const hasToolAllowField = Array.isArray(row.toolAllow)
  const hasToolDenyField = Array.isArray(row.toolDeny)

  // Pre-0.5 back-compat: row has no preset and no typed scope fields at
  // all (all null/undefined). Treat as full access.
  if (
    !hasPreset &&
    !hasCollectionScopesField &&
    !hasGlobalScopesField &&
    !hasToolAllowField &&
    !hasToolDenyField
  ) {
    return null
  }

  // Sentinel: Custom preset with every axis null/undefined (no array
  // committed) denies everything. Payload-persisted unset JSON / select
  // fields arrive as null; this is the fresh-Custom-key case.
  if (
    presetRaw === 'custom' &&
    !hasCollectionScopesField &&
    !hasGlobalScopesField &&
    !hasToolAllowField &&
    !hasToolDenyField
  ) {
    return { collections: {}, globals: {}, tools: { allow: [] } }
  }

  const out: KeyScopes = {}
  const isCustomPreset = presetRaw === 'custom'
  if (hasPreset && !isCustomPreset) {
    out.preset = presetRaw as ScopePreset
  }

  // Under non-Custom presets, the override fields are hidden in the admin
  // UI (`condition: isCustomPreset`) and Payload's hasMany / relational
  // reads return `[]` for unpopulated relations even when the user never
  // touched them. Treating that `[]` as "deny-all on this axis" turns
  // every preset key into a deny-all key once it round-trips through the
  // DB. Apply the explicit-empty-means-deny semantic only when the user
  // is on the Custom preset (where the override fields are visible and
  // meaningful); under preset modes, ignore empty arrays so that the
  // preset alone drives access. Non-empty arrays still apply as layered
  // narrowing, matching the field description ("layered on top of preset
  // and collection scopes").
  const treatEmptyAsScope = isCustomPreset

  // Legacy-row warn: non-Custom preset rows persisted BEFORE v0.7.1 may
  // carry populated override arrays from a prior Custom configuration
  // (the on-write null-out hook landed in v0.7.1). These still apply as
  // layered narrowing on read — fail-closed-safe (narrows, never widens)
  // but may not match operator intent. Warn once per process so legacy
  // rows can be audited and re-saved.
  if (
    hasPreset &&
    !isCustomPreset &&
    !warnedLegacyNonCustomOverride &&
    ((hasCollectionScopesField && (row.collectionScopes as unknown[]).length > 0) ||
      (hasGlobalScopesField && (row.globalScopes as unknown[]).length > 0) ||
      (hasToolAllowField && (row.toolAllow as unknown[]).length > 0))
  ) {
    warnedLegacyNonCustomOverride = true
    logger?.warn?.(
      { event: 'mcp.auth.legacy_non_custom_override' },
      `[payload-mcp-toolkit] composeScopes read an API key with a non-Custom preset (${presetRaw}) ` +
        `carrying populated override arrays. These still narrow access as written, but the ` +
        `v0.7.1 admin UI clears overrides on preset switch — re-save affected keys to align ` +
        `persisted state with current admin semantics.`,
    )
  }

  const emitCollectionScopes =
    hasCollectionScopesField &&
    (treatEmptyAsScope || (row.collectionScopes as unknown[]).length > 0)
  if (emitCollectionScopes) {
    const collections: Record<string, CollectionAction[]> = {}
    for (const entry of row.collectionScopes as ScopeRow[]) {
      const slug = readScopeSlug(entry, 'collection', logger)
      if (!slug) continue
      const rawActions = Array.isArray(entry?.actions) ? entry.actions : []
      const actions = rawActions.filter(
        (a): a is CollectionAction => typeof a === 'string' && VALID_ACTIONS.has(a as CollectionAction),
      )
      collections[slug] = actions
    }
    out.collections = collections
  }

  const emitGlobalScopes =
    hasGlobalScopesField &&
    (treatEmptyAsScope || (row.globalScopes as unknown[]).length > 0)
  if (emitGlobalScopes) {
    const globals: Record<string, GlobalAction[]> = {}
    for (const entry of row.globalScopes as ScopeRow[]) {
      const slug = readScopeSlug(entry, 'global', logger)
      if (!slug) continue
      const rawActions = Array.isArray(entry?.actions) ? entry.actions : []
      const actions = rawActions.filter(
        (a): a is GlobalAction => typeof a === 'string' && VALID_GLOBAL_ACTIONS.has(a as GlobalAction),
      )
      globals[slug] = actions
    }
    out.globals = globals
  }

  const toolDeny = hasToolDenyField
    ? (row.toolDeny as unknown[]).filter((t): t is string => typeof t === 'string')
    : []
  const emitDeny = toolDeny.length > 0
  const emitToolAllow =
    hasToolAllowField &&
    (treatEmptyAsScope || (row.toolAllow as unknown[]).length > 0)

  if (emitToolAllow || emitDeny) {
    out.tools = {}
    if (emitToolAllow) {
      const toolAllow = (row.toolAllow as unknown[]).filter((t): t is string => typeof t === 'string')
      out.tools.allow = toolAllow
    }
    if (emitDeny) out.tools.deny = toolDeny
  }

  return out
}

/**
 * Builds the Payload `auth.strategies` entry that authenticates MCP requests.
 *
 * Authenticates `Authorization: Bearer <plaintext>` by computing the
 * upstream-compatible `apiKeyIndex` HMAC and looking up the row. On match,
 * it fires a non-blocking `lastUsedAt` write and hydrates `req.user` with
 * the linked user record + key context for downstream scope checks.
 */
export function createBearerStrategy(options: CreateBearerStrategyOptions): AuthStrategy {
  const { collectionSlug, userCollection } = options

  return {
    name: AUTH_STRATEGY_NAME,
    authenticate: async ({ headers, payload }) => {
      const headersAny = headers as unknown as
        | { get?: (name: string) => string | null }
        | Record<string, string | undefined>
      const headerValue =
        typeof (headersAny as { get?: (name: string) => string | null }).get === 'function'
          ? (headersAny as { get: (name: string) => string | null }).get('authorization')
          : (headersAny as Record<string, string | undefined>).authorization
      const token = extractBearerToken(headerValue ?? null)
      if (!token) return { user: null }

      const keyHash = hashKey(token, payload.secret)
      const where: Where = { apiKeyIndex: { equals: keyHash } }

      let docs: ApiKeyRow[] = []
      try {
        const result = (await payload.find({
          collection: collectionSlug,
          where,
          depth: 1,
          limit: 1,
          pagination: false,
          overrideAccess: true,
        })) as unknown as { docs: ApiKeyRow[] }
        docs = result.docs ?? []
      } catch (err) {
        payload.logger.error(
          { err, event: 'mcp.auth.lookup_failed' },
          '[payload-mcp-toolkit] API-key lookup failed',
        )
        return { user: null }
      }

      const row = docs[0]
      if (!row) return { user: null }

      const now = Date.now()
      if (row.revokedAt) return { user: null }
      if (row.expiresAt) {
        const expiry = new Date(row.expiresAt).getTime()
        if (Number.isFinite(expiry) && expiry < now) return { user: null }
      }

      const linkedUser = row.user
      if (!linkedUser || typeof linkedUser !== 'object') return { user: null }

      const effectiveScopes: KeyScopes | null = composeScopes(row, payload.logger)

      // Fire-and-forget: do not block the request on this write.
      void payload
        .update({
          collection: collectionSlug,
          id: row.id,
          data: { lastUsedAt: new Date().toISOString() } as Record<string, unknown>,
          overrideAccess: true,
        })
        .catch(() => {
          // Intentionally swallow: lastUsedAt drift is acceptable.
        })

      const user = linkedUser as Record<string, unknown>
      return {
        user: {
          ...user,
          collection: userCollection,
          _strategy: AUTH_STRATEGY_NAME,
          _mcpKey: {
            keyId: row.id,
            keyPrefix: typeof row.keyPrefix === 'string' ? row.keyPrefix : null,
            scopes: effectiveScopes,
          },
        } as unknown as PayloadRequest['user'],
      }
    },
  }
}

/**
 * Reads the per-request API-key context populated by the bearer strategy.
 * Returns null for non-MCP requests (e.g. cookie-authenticated admin users).
 */
export function getApiKeyContext(req: PayloadRequest): {
  keyId: string | number
  keyPrefix: string | null
  scopes: KeyScopes | null
} | null {
  const user = req.user as
    | (Record<string, unknown> & {
        _mcpKey?: { keyId: string | number; keyPrefix: string | null; scopes: KeyScopes | null }
      })
    | null
    | undefined
  return user?._mcpKey ?? null
}
