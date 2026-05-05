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

/**
 * Pure function: translates v0.3.x's dynamic `mcpAccessSettings` field tree
 * into a v0.4 `scopes` JSON object.
 *
 * The legacy shape stores per-collection toggles like:
 *   { posts: { find: true, create: true, update: false, delete: false }, ... }
 *
 * Plus a `payload-mcp-tool` group of per-tool checkboxes.
 *
 * Translation rules:
 *   - Each `find` flag -> 'read'; `create`/`update`/`delete` map identically.
 *   - The `payload-mcp-tool` group becomes `tools.allow` (only enabled tools).
 *   - Unrecognized or malformed entries are skipped silently — we never
 *     reject auth on translator failure (that's worse UX than over-broad
 *     access surfaced as a logged warning).
 */
export function translateLegacyScopes(legacy: unknown): KeyScopes | null {
  if (!legacy || typeof legacy !== 'object') return null

  const collections: Record<string, CollectionAction[]> = {}
  let toolsAllow: string[] | undefined

  for (const [key, value] of Object.entries(legacy as Record<string, unknown>)) {
    if (key === 'payload-mcp-tool') {
      if (value && typeof value === 'object') {
        const enabled = Object.entries(value as Record<string, unknown>)
          .filter(([, on]) => on === true)
          .map(([name]) => name)
        if (enabled.length > 0) toolsAllow = enabled
      }
      continue
    }

    if (key === 'payload-mcp-resource' || key === 'payload-mcp-prompt') continue

    if (!value || typeof value !== 'object') continue
    const flags = value as Record<string, unknown>
    const actions: CollectionAction[] = []
    if (flags.find === true) actions.push('read')
    if (flags.create === true) actions.push('create')
    if (flags.update === true) actions.push('update')
    if (flags.delete === true) actions.push('delete')
    if (actions.length > 0) collections[key] = actions
  }

  const hasCollections = Object.keys(collections).length > 0
  if (!hasCollections && !toolsAllow) return null

  const scopes: KeyScopes = {}
  if (hasCollections) scopes.collections = collections
  if (toolsAllow) scopes.tools = { allow: toolsAllow }
  return scopes
}

export interface CreateBearerStrategyOptions {
  /** Slug of the API-keys collection (defaults to `payload-mcp-api-keys`). */
  collectionSlug: string
  /** Slug of the user collection that API keys link to. */
  userCollection: string
}

interface ApiKeyRow {
  id: string | number
  user: unknown
  scopes?: KeyScopes | null
  mcpAccessSettings?: unknown
  expiresAt?: string | Date | null
  revokedAt?: string | Date | null
  apiKey?: string | null
  keyPrefix?: string | null
}

/**
 * Builds the Payload `auth.strategies` entry that authenticates MCP requests.
 *
 * Authenticates `Authorization: Bearer <plaintext>` by computing the
 * upstream-compatible `apiKeyIndex` HMAC and looking up the row. On match,
 * it lazily translates legacy `mcpAccessSettings` to `scopes` JSON, fires
 * a non-blocking `lastUsedAt` write, and hydrates `req.user` with the
 * linked user record + key context for downstream scope checks.
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

      let effectiveScopes: KeyScopes | null = (row.scopes as KeyScopes | null | undefined) ?? null
      if (!effectiveScopes && row.mcpAccessSettings) {
        try {
          const translated = translateLegacyScopes(row.mcpAccessSettings)
          if (translated) {
            effectiveScopes = translated
            // Persist the translation so subsequent lookups skip this branch.
            void payload
              .update({
                collection: collectionSlug,
                id: row.id,
                data: { scopes: translated } as Record<string, unknown>,
                overrideAccess: true,
              })
              .catch((err: unknown) => {
                payload.logger.warn(
                  { err, keyId: row.id, event: 'mcp.auth.scope_migration_failed' },
                  '[payload-mcp-toolkit] Failed to persist translated scopes; continuing with in-memory translation',
                )
              })
          }
        } catch (err) {
          payload.logger.warn(
            { err, keyId: row.id, event: 'mcp.auth.scope_translate_failed' },
            '[payload-mcp-toolkit] Could not translate legacy mcpAccessSettings; treating as full access',
          )
        }
      }

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
