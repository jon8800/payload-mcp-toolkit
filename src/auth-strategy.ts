import type { AuthStrategy, PayloadRequest, Where } from 'payload'
import { extractBearerToken, hashKey } from './hash'

export const AUTH_STRATEGY_NAME = 'mcp-toolkit-bearer'

/**
 * Shape of the v0.4 `scopes` field. All three sub-fields are optional;
 * an entirely-empty `scopes` (or null) grants full access for back-compat.
 */
export type CollectionAction = 'read' | 'create' | 'update' | 'delete'
export type ScopePreset = 'read-only' | 'editor' | 'admin'

export interface KeyScopes {
  preset?: ScopePreset
  collections?: Record<string, CollectionAction[]>
  tools?: { allow?: string[]; deny?: string[] }
}

export interface CreateBearerStrategyOptions {
  /** Slug of the API-keys collection (defaults to `payload-mcp-api-keys`). */
  collectionSlug: string
  /** Slug of the user collection that API keys link to. */
  userCollection: string
}

interface CollectionScopeRow {
  collection?: unknown
  actions?: unknown
}

interface ApiKeyRow {
  id: string | number
  user: unknown
  preset?: ScopePreset | 'custom' | null
  collectionScopes?: CollectionScopeRow[] | null
  toolAllow?: string[] | null
  toolDeny?: string[] | null
  expiresAt?: string | Date | null
  revokedAt?: string | Date | null
  apiKey?: string | null
  keyPrefix?: string | null
}

const VALID_ACTIONS: ReadonlySet<CollectionAction> = new Set(['read', 'create', 'update', 'delete'])

/**
 * Builds the runtime `KeyScopes` shape consumed by `registry.assertScopeAllows`
 * from the typed scope fields on the api-key row.
 *
 * Returns null when no typed fields are populated (= full access — back-compat
 * for keys that pre-date scoped authz).
 *
 * Fail-closed contract for the `'custom'` preset:
 *   - `'custom'` is a UI sentinel meaning "use my override fields"; it never
 *     becomes `KeyScopes.preset` itself.
 *   - When the operator selects `'custom'` but populates no overrides, this
 *     function returns an explicit deny-all shape (`{ collections: {}, tools:
 *     { allow: [] } }`) so the registry rejects every dispatch instead of
 *     falling through to the "no scopes set = full access" guard.
 *   - Partial-override custom keys (only `collectionScopes`, or only
 *     `toolAllow` / `toolDeny`) are honoured as written — the deny-all
 *     sentinel only fires when ALL override fields are empty.
 */
export function composeScopes(row: ApiKeyRow): KeyScopes | null {
  const presetRaw = row.preset
  const hasPreset = typeof presetRaw === 'string' && presetRaw.length > 0
  const collectionScopes = Array.isArray(row.collectionScopes) ? row.collectionScopes : []
  const hasCollectionScopes = collectionScopes.length > 0
  const toolAllow = Array.isArray(row.toolAllow) ? row.toolAllow.filter((t) => typeof t === 'string') : []
  const toolDeny = Array.isArray(row.toolDeny) ? row.toolDeny.filter((t) => typeof t === 'string') : []
  const hasToolAllow = toolAllow.length > 0
  const hasToolDeny = toolDeny.length > 0

  if (!hasPreset && !hasCollectionScopes && !hasToolAllow && !hasToolDeny) {
    return null
  }

  // Custom preset with no overrides: deny everything. The empty `collections`
  // whitelist denies every collection-scoped tool, and the empty `tools.allow`
  // list denies every tool dispatch — so account-wide tools (uploadMedia,
  // searchContent, etc.) are also denied.
  if (presetRaw === 'custom' && !hasCollectionScopes && !hasToolAllow && !hasToolDeny) {
    return { collections: {}, tools: { allow: [] } }
  }

  const out: KeyScopes = {}
  if (hasPreset && presetRaw !== 'custom') {
    out.preset = presetRaw as ScopePreset
  }
  if (hasCollectionScopes) {
    const collections: Record<string, CollectionAction[]> = {}
    for (const entry of collectionScopes) {
      const slug = typeof entry?.collection === 'string' ? entry.collection : null
      if (!slug) continue
      const rawActions = Array.isArray(entry?.actions) ? entry.actions : []
      const actions = rawActions.filter(
        (a): a is CollectionAction => typeof a === 'string' && VALID_ACTIONS.has(a as CollectionAction),
      )
      collections[slug] = actions
    }
    if (Object.keys(collections).length > 0) {
      out.collections = collections
    }
  }
  if (hasToolAllow || hasToolDeny) {
    out.tools = {}
    if (hasToolAllow) out.tools.allow = toolAllow
    if (hasToolDeny) out.tools.deny = toolDeny
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

      const effectiveScopes: KeyScopes | null = composeScopes(row)

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
