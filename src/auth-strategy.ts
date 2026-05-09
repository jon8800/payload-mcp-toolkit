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

interface ApiKeyRow {
  id: string | number
  user: unknown
  scopes?: KeyScopes | null
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

      const effectiveScopes: KeyScopes | null =
        (row.scopes as KeyScopes | null | undefined) ?? null

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
