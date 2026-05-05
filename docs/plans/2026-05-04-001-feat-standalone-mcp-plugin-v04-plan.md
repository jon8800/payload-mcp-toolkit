---
title: "feat: Standalone Payload MCP plugin (v0.4)"
type: feat
status: completed
date: 2026-05-04
origin: docs/brainstorms/standalone-plugin-2026-05-04.md
---

# feat: Standalone Payload MCP plugin (v0.4)

## Summary

Convert `payload-mcp-toolkit` from a wrapper around `@payloadcms/plugin-mcp` into a standalone Payload v3 plugin. The toolkit owns the `/api/mcp` HTTP endpoint, the `payload-mcp-api-keys` collection (with a redesigned scoped-authz schema), and bearer authentication via Payload's native `auth.strategies` extension point. `find` / `delete` tools, currently delegated to the upstream plugin's converter-driven path, are reimplemented locally as polymorphic local-API tools mirroring the existing `createDocument` / `updateDocument` contract. The package name stays `payload-mcp-toolkit`.

---

## Problem Frame

The 0.3.x cycle has been a sequence of patches each disabling another piece of the upstream plugin's converter-driven authoring surface. The toolkit now ships local-API replacements for the broken parts, but still pays the cost of wrapping a dependency whose remaining surface (transport, auth, API-key collection, find/delete) is small enough to own directly. Web research (2026-05-04) confirmed no upstream rewrite is in flight, and v3.83's external-tool extension hook signals upstream expects plugin authors to work around the built-ins. Forking is the durable path. Full motivation, alternatives considered (upstream PR, minimal upstream change, README rewrite), and risk treatment live in the origin brainstorm.

---

## Requirements

- R1. Drop `@payloadcms/plugin-mcp` from `peerDependencies`. The toolkit must not require any upstream MCP plugin to function.
- R2. Register `/api/mcp` POST + GET endpoints via Payload's `config.endpoints`. POST handles JSON-RPC 2.0 MCP requests; GET returns a spec-compliant JSON-RPC error.
- R3. Reimplement bearer-token auth as a Payload `auth.strategies` entry on the API-keys collection. Authorization header `Bearer <key>` looks up the key by HMAC, populates `req.user` from the linked user.
- R4. Ship a redesigned `payload-mcp-api-keys` collection schema with a stable JSON `scopes` field (role presets + per-collection / per-tool overrides), lifecycle fields (`expiresAt`, `lastUsedAt`, `revokedAt`, `name`, `description`), and a one-time silent migration that reads upstream's dynamic `mcpAccessSettings` shape on first lookup and writes the translated `scopes` JSON back. Slug preserved verbatim (`payload-mcp-api-keys`) for zero-touch row compatibility.
- R5. Reimplement `find<Resource>` and `delete<Resource>` as polymorphic toolkit tools (`findDocument`, `deleteDocument`) keyed by a `collection` arg, mirroring the existing `createDocument` / `updateDocument` shape. Existing `safeDelete` stays; `deleteDocument` is the fast unsafe variant.
- R6. Detect plugin conflict on init: if `@payloadcms/plugin-mcp` is also installed and registered, throw a helpful error directing the user to remove it. Boot must not silently succeed with two plugins fighting for the same collection slug.
- R7. Enforce per-key authorization at the tool-call dispatch site. Each MCP `tools/call` invocation reads the API-key's `scopes` and rejects calls whose collection/tool isn't allowed, with a useful JSON-RPC error.
- R8. Audit-log every successful and failed tool call via `req.payload.logger` (key id, tool name, sanitized arg summary, success/failure, duration, request id). No new logging transport.
- R9. Origin/Host validation on `/api/mcp` to block DNS-rebinding attacks against local Payload instances. Default to no CORS exposure; expose an explicit `allowedOrigins` config option.
- R10. The toolkit's existing tool factory contract (`parameters: { [key]: ZodType }`, `handler: async (args, req, _extra) => McpTextResponse`) must continue to work without per-tool rewrites. Adapter at the SDK registration site wraps `parameters` into the SDK's `inputSchema` Zod object.
- R11. Existing API-key rows authenticate without re-issue on upgrade. The `key` / `keyHash` / linked-user fields are preserved exactly; the dynamic `mcpAccessSettings` field tree is replaced by `scopes` JSON, with on-demand migration.
- R12. Ship version `0.4.0` with a CHANGELOG entry, README rewrite leading with the standalone story, and an "Upgrading from 0.3.x" section covering: removing `mcpPlugin` from `plugins[]`, the API-key schema migration, the new `scopes` config shape.

---

## Scope Boundaries

- **No SSE / streaming transport in v0.4.** Endpoint is HTTP-POST only (`disableSse: true` on the `mcp-handler` config). SSE deferred to a later release; impact noted in Risks.
- **No new admin UI panel** for API-key management. Admins use Payload's default collection list view. Custom panel is in the future-work doc.
- **No CLI / browser playground.** Future-work doc.
- **No rate limiting on auth failures.** Acceptable because keys are 32-byte CSPRNG output (256 bits); brute-force is not realistic. Revisit if scoped keys land in v0.5.
- **No upstream `@payloadcms/plugin-mcp` PR or issue filing.** Out of scope per the brainstorm; can be filed in parallel as a hedge but doesn't block v0.4.
- **No package rename.** Stays `payload-mcp-toolkit`.

### Deferred to Follow-Up Work

- Admin UI panel for API-key management — see `docs/brainstorms/standalone-plugin-future-work-2026-05-04.md`
- CLI / browser playground — see future-work doc
- Code-Connect-style per-collection narrative metadata — see future-work doc
- SSE / streaming transport — separate v0.5+ release
- Rate limiting — v0.5 once usage signals exist
- Upstream PR / issue filing — opportunistic, not blocking

---

## Context & Research

### Relevant Code and Patterns

- `src/index.ts` — current `contentToolkitPlugin` factory; the `mcpPlugin(...)` call at the bottom is the integration seam to replace.
- `src/draft-workflow.ts` — `generateMcpCollectionConfigs` produces the upstream `mcpCollections` shape; will be slimmed to expose only `draftCollections: Set<string>` plus an `excluded` set.
- `src/tools/_helpers.ts` — `textResponse`, `jsonResponse`, `errorMessage`, `stampMcpContext`, `getDocDisplayName`, `requireDraftCollection`. Pattern to mirror in new tools.
- `src/tools/create-document.ts` — canonical complex tool factory with description-builder pattern; `findDocument` and `deleteDocument` should mirror its shape.
- `src/tools/publish-draft.ts` — canonical minimal factory.
- `src/tools/safe-delete.ts` — relationship-aware delete; stays as-is; `deleteDocument` lives alongside as the unsafe-fast path.
- `src/types.ts` — `ContentToolkitOptions` is the single public option type; `scopes` config doesn't belong here (lives on each API-key row).
- `src/__tests__/introspection.test.ts` — vitest pattern; pure-function tests with inline fixtures. No `payload.create()` mocking pattern exists yet — this plan establishes one via `vi.fn()` stubs.
- `package.json` — `peerDependencies` currently `@payloadcms/plugin-mcp ^3`, `payload ^3`, `zod ^3`. Replace first entry with `mcp-handler ^1.1` and `@modelcontextprotocol/sdk ^1.18`.
- `dev/payload.config.ts` — sandbox config; needs the wrapper-plugin import removed.

### Institutional Learnings

- `docs/solutions/architecture-patterns/payload-plugin-config-inference-2026-05-04.md` — "infer plugin configuration from Payload's own schema, not parallel declaration." Directly governs U2-U6: read what's already declared (`auth.user`, `versions.drafts`, `admin.livePreview.url`, etc.), delegate to host extension points (`auth.strategies`, `endpoints`), don't restate.

### External References

- **`mcp-handler@1.1.0`** (Vercel, Apache-2.0) — `createMcpHandler(initializeServer, serverOptions?, config?)` returns `(req: Request) => Promise<Response>`. `disableSse: true` skips Redis. **No `globalThis.Request/Response` mutation in 1.1.0** — the brainstorm's clobber-guard concern was from a prior version using `@hono/node-server`'s `getRequestListener`; current version is a clean Fetch handler. https://github.com/vercel/mcp-handler
- **`@modelcontextprotocol/sdk@1.18+`** — `McpServer.registerTool(name, { inputSchema, ... }, handler)` where `inputSchema` is a Zod object's `.shape`, not a wrapped `z.object`. SDK auto-routes `initialize` / `tools/list` / `tools/call` / `resources/list` / `resources/read` / `prompts/list` / `prompts/get`. Tool-execution failures return a successful result with `isError: true`, not a JSON-RPC error. Pin Zod ≥ 3.25 (SDK uses `zod/v4` imports internally; ≤ 1.17.4 breaks with Zod v4). https://github.com/modelcontextprotocol/typescript-sdk
- **Payload v3 `config.endpoints`** — `{ path, method, handler: (req: PayloadRequest) => Response | Promise<Response> }`. Same `path` with different `method` registers two routes. https://payloadcms.com/docs/rest-api/overview
- **Payload v3 `auth.strategies`** — per-collection `{ name, authenticate: ({ headers, payload }) => Promise<{ user: { collection, ...userDoc } | null }> }`. Strategies short-circuit on first non-null user. The returned user must have `collection` set so Payload knows the principal's home. https://payloadcms.com/docs/authentication/custom-strategies
- **Hash strategy for high-entropy keys** — HMAC-SHA-256 with server-side pepper, NOT Argon2id/bcrypt. KDFs exist to slow brute-force on low-entropy passwords; for 256-bit CSPRNG tokens they only add per-request latency. Per-row salt is unnecessary for the same reason. `crypto.timingSafeEqual` for comparison. OWASP Password Storage Cheat Sheet. **This is a deliberate departure from the brainstorm's security spec** — captured under Key Technical Decisions.

---

## Key Technical Decisions

- **Hash strategy: HMAC-SHA-256 with a server-side pepper, no per-row salt.** Departs from the brainstorm's "salted SHA-256" / "Argon2id KDF" spec. Rationale: API keys are 32-byte (256-bit) CSPRNG output, not user passwords. KDFs exist to slow guess attacks on low-entropy inputs; applied to high-entropy machine secrets they only add latency to every authenticated request. The pepper is read from `payloadSecret` (already required by Payload, already in env) plus an internal namespacing string so the same secret can't accidentally collide with other HMAC use sites.
- **Constant-time comparison via `crypto.timingSafeEqual`** even though DB lookup is by hash equality. Defense-in-depth — never compare token-derived strings with `===`.
- **Auth via `auth.strategies`, not endpoint middleware.** Payload's strategy hook populates `req.user` natively, integrates with `overrideAccess` checks elsewhere in the request lifecycle, and lets users layer additional strategies (e.g., for browser-side admin sessions) without us coordinating.
- **Scoped-authz JSON field, not a dynamic field tree.** A single `scopes` JSON column carries `{ preset?: 'read-only' | 'editor' | 'admin', collections?: { [slug]: Action[] }, tools?: { allow?: string[], deny?: string[] } }`. Schema is stable when collections are added. Migrating from upstream's dynamic `mcpAccessSettings` happens lazily on first lookup of a row that has the legacy shape, with a one-time write of the translated `scopes` JSON.
- **`disableSse: true` on the `mcp-handler` config.** No Redis dependency surface inherited. SSE deferred to v0.5+.
- **Tool input schema adapter at the registration site.** Existing tools keep their `parameters: { [key]: ZodType }` shape. The new registry wraps each into `z.object(parameters)` when calling `server.registerTool(name, { inputSchema: shape }, handler)`. Avoids per-tool rewrites.
- **Polymorphic `findDocument` / `deleteDocument`, not per-collection tools.** Mirrors existing `createDocument` / `updateDocument`. One tool, `collection` as an arg, schemas built once from `collectionSchemas`. Reduces tool count and matches the toolkit's existing AI-friendly pattern.
- **Plugin-conflict detection at init.** Throw a clear error if `incomingConfig.plugins` already includes `@payloadcms/plugin-mcp` or if a collection with slug `payload-mcp-api-keys` is already in `incomingConfig.collections` from another source.
- **Scopes default = full access.** Rows whose `scopes` is `null` / absent get full access. Preserves backcompat with existing upstream rows that haven't been migrated yet (the migration also sets `scopes` based on the legacy `mcpAccessSettings`).

---

## Open Questions

### Resolved During Planning

- **Does `mcp-handler` mutate globalThis?** No, not in 1.1.0. Brainstorm finding superseded by direct source inspection.
- **Is `find<Resource>` upstream converter-affected?** No — input schemas are static Zod (`where`/`select`/`sort` as JSON-string fields). Reimplementing is a perf simplification, not a parity risk port.
- **Hash strategy for high-entropy keys?** HMAC-SHA-256 with pepper. See Key Technical Decisions.
- **Tool factory contract change?** None — adapter at registration site preserves the existing `parameters: ZodRecord` shape.
- **Per-key authz model for v0.4?** Scoped (JSON `scopes` field with role presets + overrides). Confirmed with user during planning.

### Deferred to Implementation

- **Exact JSON shape of the legacy → `scopes` translation.** Depends on inspecting a few real upstream rows during the spike. The translator is a pure function; iterating its mapping table is implementation-time work.
- **Whether `safeDelete` and `deleteDocument` should share underlying logic.** Could deduplicate by having `deleteDocument` call into `safeDelete` with `confirm: true` — but `safeDelete`'s relationship-walk is heavyweight for the unsafe path. Decide during U6.
- **Audit log field schema.** Use `req.payload.logger.info(...)` with a structured object; exact field names settle during implementation. Required fields known: key id, tool name, sanitized arg summary, success/failure, duration, request id.

---

## Output Structure

    src/
      api-keys.ts            (new) — collection factory + scopes field schema
      auth-strategy.ts       (new) — bearer-token strategy + legacy-row migration
      endpoint.ts            (new) — POST + GET /api/mcp registration via mcp-handler
      registry.ts            (new) — Zod adapter + scope-gating dispatcher + audit log
      hash.ts                (new) — HMAC-SHA-256 + timingSafeEqual helpers
      conflict-detection.ts  (new) — init-time guard against double-plugin install
      index.ts               (rewrite) — drops mcpPlugin call, wires the new modules
      draft-workflow.ts      (slim) — keeps draftCollections set + preview decorator only
      tools/
        find-document.ts     (new) — polymorphic find tool
        delete-document.ts   (new) — polymorphic delete (fast path)
        _helpers.ts          (extend) — add decorateDraftResponse() preview helper
        ... (existing tools unchanged)
      __tests__/
        api-keys.test.ts     (new)
        auth-strategy.test.ts (new) — includes legacy-migration path
        registry.test.ts     (new) — adapter + scope gate
        hash.test.ts         (new)
        find-document.test.ts (new)
        delete-document.test.ts (new)
        conflict-detection.test.ts (new)

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Tool-call request lifecycle

```
Client (MCP)                Payload                       Toolkit
    |                          |                             |
    |---- POST /api/mcp ------>|                             |
    |     (Bearer <key>)       |                             |
    |                          |-- auth.strategies --------->|
    |                          |                             | hash(presented) == row.keyHash?
    |                          |                             | row.expiresAt > now? not revoked?
    |                          |                             | translate legacy scopes if needed
    |                          |<-- { user: linkedUser } ----|
    |                          |                             |
    |                          |-- endpoint handler -------->|
    |                          |                             | mcp-handler (disableSse=true)
    |                          |                             | -> McpServer dispatch
    |                          |                             |    -> tools/call(name, args)
    |                          |                             |       -> registry.dispatch:
    |                          |                             |          | scope-check(name, args.collection)
    |                          |                             |          | stampMcpContext(req)
    |                          |                             |          | tool.handler(args, req)
    |                          |                             |          | logger.info(audit fields)
    |<------- response --------|<----------------------------|
```

### Scopes shape

```
scopes (JSON column on payload-mcp-api-keys row):
  {
    preset?: 'read-only' | 'editor' | 'admin',
    collections?: { [slug]: Array<'read' | 'create' | 'update' | 'delete'> },
    tools?: { allow?: string[], deny?: string[] }
  }

Resolution at dispatch time:
  effective = expand(preset) merged-with collections-overrides
  if tools.allow set -> tool must be in allow
  if tools.deny set -> tool must not be in deny
  if scopes is null/undefined -> full access (backcompat)

Presets:
  read-only -> all collections: ['read'], tools: allow=['findDocument', 'searchContent', 'resolveReference']
  editor    -> all collections: ['read','create','update'], tools: deny=['safeDelete','deleteDocument']
  admin     -> all collections: ['read','create','update','delete'], tools: <all>
```

### Legacy-row migration (one-time, lazy)

```
On lookup of a row where scopes is unset AND mcpAccessSettings is present:
  translatedScopes = translateLegacy(mcpAccessSettings):
    foreach [slug, flags] in mcpAccessSettings:
      collections[slug] = [
        flags.find && 'read', flags.create && 'create',
        flags.update && 'update', flags.delete && 'delete'
      ].filter(Boolean)
    if mcpAccessSettings['payload-mcp-tool']:
      tools.allow = Object.entries(mcpAccessSettings['payload-mcp-tool'])
                          .filter(([, on]) => on).map(([name]) => name)
  payload.update(row.id, { scopes: translatedScopes }, { overrideAccess: true })
```

---

## Implementation Units

- U1. **Scaffold standalone deps and dev harness**

**Goal:** Replace the upstream peer dep with `mcp-handler` + `@modelcontextprotocol/sdk` direct deps, update the dev sandbox to remove the wrapper, bump version to `0.4.0-alpha.0`, and add a smoke check that the package builds and types resolve.

**Requirements:** R1, R12

**Dependencies:** None

**Files:**
- Modify: `package.json` (peerDependencies, dependencies, version)
- Modify: `dev/payload.config.ts` (drop wrapper-only imports if any)
- Modify: `pnpm-lock.yaml` (regenerated)

**Approach:**
- Remove `@payloadcms/plugin-mcp` from `peerDependencies`. Add `mcp-handler ^1.1.0` and `@modelcontextprotocol/sdk ^1.18.0` as direct dependencies (not peers — toolkit owns these).
- Bump `version` to `0.4.0-alpha.0`. Final v0.4.0 tag waits until U8 ships.
- Verify dev sandbox boots without the upstream plugin in `plugins[]`. The sandbox already calls `contentToolkitPlugin(...)` directly per current code — only changes are upstream import removal if any reference exists.
- Run `pnpm build` to confirm TS types still resolve after the dep swap. No code changes outside `package.json` / `dev/` yet — just the dep surface.

**Patterns to follow:**
- Existing `package.json` `publishConfig.exports` swap.

**Test scenarios:**
- Test expectation: none — pure dep + version metadata change. Build success is verification.

**Verification:**
- `pnpm install` succeeds without warnings about missing peer `@payloadcms/plugin-mcp`.
- `pnpm build` produces `dist/index.js` and `dist/index.d.ts`.
- `pnpm dev` (sandbox) boots without runtime errors. Tool registration may not yet work — that's expected; the rest of the units wire it.

---

- U2. **API-keys collection with scoped schema**

**Goal:** Ship `src/api-keys.ts` exporting `createApiKeysCollection({ slug = 'payload-mcp-api-keys', userCollection })`. Schema: stable JSON `scopes` field, lifecycle fields, key/keyHash split with one-time plaintext disclosure on creation. Slug preserved verbatim.

**Requirements:** R4, R11

**Dependencies:** U1

**Files:**
- Create: `src/api-keys.ts`
- Test: `src/__tests__/api-keys.test.ts`

**Approach:**
- Fields: `name` (text, required), `description` (textarea, optional), `user` (relationship to `userCollection`, required), `key` (text, virtual / write-only — value shown once on creation, never read after), `keyPrefix` (text, indexed — first 8 chars of plaintext for human identification + audit-log key id), `keyHash` (text, indexed, hidden from admin UI), `scopes` (json, optional), `expiresAt` (date, optional), `lastUsedAt` (date, read-only, set by auth strategy), `revokedAt` (date, optional), `mcpAccessSettings` (json, hidden, kept readable for one-time migration — drop in v0.5).
- `beforeChange` hook on create: generate 32 random bytes, base64url encode, set `key` to `mcp_live_<base64url>`, derive `keyHash` via the helper from U3 (or U2 imports `hash.ts` directly), set `keyPrefix` to first 8 chars of the plaintext, return the doc with the plaintext `key` populated for the response (Payload returns the create response before stripping write-only fields).
- `afterRead` hook: ensure `key` and `keyHash` never appear in read responses. `keyHash` is hidden via field config; `key` should be additionally scrubbed if Payload's hidden-on-read isn't sufficient (verify behavior in U2 tests).
- Admin labels: `singular: 'API Key'`, `plural: 'API Keys'`. Group under a `MCP` admin nav group if Payload supports it (matches upstream convention).

**Patterns to follow:**
- Payload-CMS field config patterns from existing toolkit collections used in dev sandbox.
- Upstream `node_modules/@payloadcms/plugin-mcp/dist/collections/createApiKeysCollection.js` for the slug, label, and admin metadata — but NOT the dynamic per-collection enable-flag tree (that's the part we're replacing).

**Test scenarios:**
- Happy path: factory called with `{ slug: 'payload-mcp-api-keys', userCollection: 'users' }` returns a CollectionConfig with all expected fields.
- Happy path: collection slug is exactly `payload-mcp-api-keys` when no override given.
- Happy path: `user` field's `relationTo` matches the passed `userCollection`.
- Edge case: factory called with custom slug returns config with that slug, but the conflict-detector (U7) still warns.
- Edge case: factory called without `userCollection` throws a useful error before returning.
- Integration: create-flow simulation — given a pre-image doc, the `beforeChange` hook produces a `key` matching `/^mcp_live_[A-Za-z0-9_-]{43}$/` and a `keyHash` of expected length.

**Verification:**
- Collection registers cleanly in a dev Payload boot.
- Creating an API key via admin UI returns the plaintext key once; subsequent reads return only the prefix + hash.

---

- U3. **HMAC + bearer auth strategy with legacy-row migration**

**Goal:** Ship `src/hash.ts` (HMAC-SHA-256 + `timingSafeEqual` helpers) and `src/auth-strategy.ts` (Payload `auth.strategies` entry that authenticates Bearer tokens, hydrates `req.user` from the linked user, sets `lastUsedAt`, and translates legacy `mcpAccessSettings` to `scopes` JSON on first lookup).

**Requirements:** R3, R4, R11

**Dependencies:** U2

**Files:**
- Create: `src/hash.ts`
- Create: `src/auth-strategy.ts`
- Test: `src/__tests__/hash.test.ts`
- Test: `src/__tests__/auth-strategy.test.ts`

**Approach:**
- `hash.ts`: `hashKey(plaintext: string, payloadSecret: string): string` — HMAC-SHA-256 of `payloadSecret + ':' + 'payload-mcp-toolkit:apikey'` over the plaintext, returned as hex. `verifyHash(presented: string, stored: string): boolean` — constant-time via `crypto.timingSafeEqual` after a length check.
- `auth-strategy.ts` exports `createBearerStrategy({ collectionSlug, userCollection })`:
  - `name: 'mcp-toolkit-bearer'`.
  - `authenticate({ headers, payload })`:
    - Read `authorization`. If missing or doesn't start with `Bearer `, return `{ user: null }`.
    - Slice the prefix; trim. Compute `keyHash`.
    - `payload.find({ collection: collectionSlug, where: { keyHash: { equals: keyHash } }, depth: 1, limit: 1, overrideAccess: true })`.
    - If 0 docs OR `revokedAt` set OR `expiresAt < now`, return `{ user: null }`. (Don't disclose which condition failed — same null response.)
    - If `scopes` is unset/null AND `mcpAccessSettings` has data, run the legacy translator (pure function) and `payload.update` the row with the translated `scopes`. Don't block auth on translation failure — log and continue with `null` scopes (= full access default).
    - `payload.update(row.id, { lastUsedAt: new Date() }, { overrideAccess: true })` — fire-and-forget; don't block the request on the write.
    - Return `{ user: { ...linkedUser, collection: userCollection } }`.
- Translator helper (`translateLegacyScopes(mcpAccessSettings)`) is a pure function; tests cover it directly.

**Execution note:** Test-first for the hash helpers and the translator — both are pure and easy to characterize.

**Patterns to follow:**
- `src/tools/_helpers.ts` for the helper-module shape.
- Payload's `auth.strategies` doc example for the `authenticate` return shape.

**Test scenarios:**
- Happy path: `hashKey('mcp_live_abc...', 'secret')` returns a 64-char hex string.
- Happy path: `verifyHash` returns `true` for matching hashes, `false` otherwise. Different lengths return `false` without throwing.
- Edge case: `verifyHash('a', 'ab')` returns `false` (length mismatch handled before `timingSafeEqual`).
- Happy path (auth): valid Bearer token → returns `{ user: { ...linkedUser, collection: 'users' } }`. `lastUsedAt` is set.
- Error path (auth): missing Authorization header → `{ user: null }`.
- Error path (auth): wrong scheme (`Basic xxx`) → `{ user: null }`.
- Error path (auth): valid format but no matching `keyHash` row → `{ user: null }`.
- Error path (auth): matching row with `revokedAt` set → `{ user: null }`.
- Error path (auth): matching row with `expiresAt < now` → `{ user: null }`.
- Integration: legacy row (no `scopes`, has `mcpAccessSettings`) authenticates AND triggers a `payload.update` writing the translated `scopes`. Verify translator output against a fixture of upstream's actual shape.
- Edge case: legacy row whose `mcpAccessSettings` is malformed (missing keys, unexpected types) → auth still succeeds with `scopes` left null (full access default), error logged.
- Integration: token that hashes to a row whose linked user no longer exists → `{ user: null }`. Not a crash.

**Verification:**
- A real Payload sandbox with a seeded API-key row authenticates a `curl -H "Authorization: Bearer <plaintext>" /api/mcp` request and `req.user` is populated downstream.

---

- U4. **MCP HTTP endpoint registration**

**Goal:** Ship `src/endpoint.ts` exporting a function that returns the two `config.endpoints` entries (POST + GET on `/api/mcp`) wrapped around a `mcp-handler` instance. Includes Origin/Host validation and an opt-in CORS allowlist.

**Requirements:** R2, R6 (partial — collection conflict in U7), R9

**Dependencies:** U3

**Files:**
- Create: `src/endpoint.ts`
- Test: `src/__tests__/endpoint.test.ts`

**Approach:**
- `createMcpEndpoints({ initializeServer, allowedOrigins })` returns `Endpoint[]` for Payload's `config.endpoints`.
- Internally call `createMcpHandler(initializeServer, undefined, { disableSse: true, basePath: '/api/mcp', verboseLogs: false })` to get a Fetch-style handler.
- POST endpoint: `{ path: '/mcp', method: 'post', handler: (req) => guardAndDispatch(req) }` where `guardAndDispatch`:
  - Validates `Host` header matches `incomingConfig.serverURL` (when set). If mismatch, return `Response.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid host' } }, { status: 400 })`.
  - If `Origin` header present, validate against `allowedOrigins` allowlist. Empty/unset allowlist = no browsers (server-to-server only). `*` is not accepted.
  - Otherwise hands off to the `mcp-handler` instance.
- GET endpoint: `{ path: '/mcp', method: 'get', handler: () => Response.json({ jsonrpc: '2.0', error: { code: -32600, message: 'POST required for MCP requests' } }, { status: 405 }) }`. Mirrors upstream's behavior so probing clients get a useful error.
- Endpoints are pushed into `incomingConfig.endpoints` (additive) by U7, not replacing.

**Patterns to follow:**
- Payload v3 endpoint shape from docs.
- `mcp-handler` README usage for `createMcpHandler` invocation.

**Test scenarios:**
- Happy path (POST): valid POST with proper Host + no Origin header → handler delegates to `mcp-handler` mock, returns its response.
- Happy path (GET): GET to `/api/mcp` returns 405 with JSON-RPC error body.
- Error path: POST with `Host: attacker.com` when `serverURL: 'https://app.com'` → 400 with `Invalid host` JSON-RPC error.
- Error path: POST with `Origin: https://other.com` and `allowedOrigins: ['https://app.com']` → 403 with `Origin not allowed` JSON-RPC error.
- Edge case: POST with no Origin header (server-to-server) succeeds even when `allowedOrigins` is empty.
- Edge case: `serverURL` not set in Payload config → Host validation skipped (no false-positive blocks in dev).
- Integration: full POST → mcp-handler → registered tool → response, with auth strategy populating `req.user`. Mocks tool handler and asserts handler args contain expected `req`.

**Verification:**
- `curl -i -X GET /api/mcp` returns 405 with the spec error body.
- `curl -X POST -H "Host: bad.example" /api/mcp` returns 400.
- `curl -X POST -H "Authorization: Bearer ..." -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' /api/mcp` returns the registered tool list.

---

- U5. **Tool registry adapter, scope gate, and audit log**

**Goal:** Ship `src/registry.ts` that takes the toolkit's existing tools/prompts/resources arrays + a `req` reference and registers them on a `McpServer`, gating `tools/call` on the API-key's `scopes`, stamping MCP context, and emitting structured audit-log entries.

**Requirements:** R5, R7, R8, R10

**Dependencies:** U2, U3

**Files:**
- Create: `src/registry.ts`
- Test: `src/__tests__/registry.test.ts`

**Approach:**
- `createInitializeServer({ tools, prompts, resources, getApiKeyContext })` returns the `(server: McpServer) => void` callback that `mcp-handler` invokes per request.
- Inside, iterate `tools` and call `server.registerTool(tool.name, { description: tool.description, inputSchema: z.object(tool.parameters).shape }, wrapHandler(tool))`. Adapter wraps the existing `parameters: ZodRecord` shape.
- `wrapHandler(tool)` returns an async fn `(args, extra) => result`:
  - Pull `req` from `extra` (the SDK passes through whatever `mcp-handler` provides; verify shape during U5 spike).
  - `apiKeyContext = getApiKeyContext(req)` returns `{ keyId, keyPrefix, scopes }` from `req.user` or `req`-attached state populated by U3.
  - Run `assertScopeAllows(apiKeyContext.scopes, tool.name, args.collection)`. If not allowed, return a successful MCP result with `isError: true` and a useful content message — NOT a JSON-RPC error (per spec, tool-execution failures use the result envelope so the LLM can self-correct).
  - `stampMcpContext(req)`. Start timer.
  - `try { result = await tool.handler(args, req, extra); logSuccess(...); return result } catch (err) { logFailure(...); return errorResult }`.
- Same pattern for prompts (`registerPrompt`) and resources (`registerResource`), but without scope gating (resources are reads; prompts are static). Audit-log resource reads with the same shape.
- Scope evaluation (`assertScopeAllows`):
  - If `scopes` is `null`/undefined → allow (backcompat, full access).
  - Resolve preset → expand to per-collection action set.
  - Merge `scopes.collections` overrides (override replaces preset for that slug).
  - For tool calls with a `collection` arg, check the action implied by the tool name (`findDocument` → `read`, `createDocument` → `create`, `updateDocument` / `patchLayout` / `publishDraft` → `update`, `deleteDocument` / `safeDelete` → `delete`, `searchContent` / `resolveReference` / `versions` → `read`).
  - For tool-name allow/deny: `scopes.tools.allow` (if present, tool must be in list); `scopes.tools.deny` (if present, tool must not be in list).
- Audit log fields: `{ event: 'mcp.tool_call', keyId, keyPrefix, tool, collectionArg, success, isError, durationMs, requestId, errorClass? }`. `requestId` from `req.headers['x-request-id']` if present, else generated.
- Sanitize args before logging: truncate any string field over 200 chars to `<truncated:N>`. Never log full document bodies on creates/updates.

**Patterns to follow:**
- `src/tools/_helpers.ts` `stampMcpContext`, `textResponse`, `errorMessage`.
- Existing tool factories' try/catch flatten pattern.

**Test scenarios:**
- Happy path: tool registered with valid scopes preset `'admin'` → tool handler invoked, success log emitted.
- Edge case: `scopes` is null → tool handler invoked (backcompat full access), log emitted.
- Error path: scopes restrict to `read-only`, tool is `createDocument` → returns `isError: true` result with scope-rejection message; log records `success: false`.
- Error path: scopes have `tools.deny: ['safeDelete']`, tool is `safeDelete` → blocked, isError result.
- Edge case: `tools.allow: ['findDocument']`, call to `searchContent` → blocked.
- Edge case: scopes have per-collection override `posts: ['read']`, call `updateDocument({ collection: 'posts' })` → blocked even though preset would allow it.
- Edge case: tool call without a `collection` arg (e.g. `searchContent`) → only tool-name allow/deny applies; no collection check.
- Integration: tool handler throws → wrapped to error result, log records error class, no exception escapes to `mcp-handler`.
- Edge case: arg with a 5KB `data` JSON string → log records `<truncated:5120>` not the full string.

**Verification:**
- A `tools/call` for `createDocument` with a `read-only` key returns the SDK result envelope with `isError: true` and a clear scope-rejection message in `content`.
- The same call writes a structured log entry visible via `payload.logger`.

---

- U6. **`findDocument` and `deleteDocument` tools**

**Goal:** Ship `src/tools/find-document.ts` and `src/tools/delete-document.ts` as polymorphic tools mirroring `createDocument` / `updateDocument` shape. Reuse `decorateDraftResponse` for draft-aware preview URL injection on find responses.

**Requirements:** R5

**Dependencies:** U5

**Files:**
- Create: `src/tools/find-document.ts`
- Create: `src/tools/delete-document.ts`
- Modify: `src/tools/_helpers.ts` — extract draft preview decoration into `decorateDraftResponse(doc, collection, req)`
- Test: `src/__tests__/find-document.test.ts`
- Test: `src/__tests__/delete-document.test.ts`

**Approach:**
- `createFindDocumentTool(collectionSchemas, draftCollections, previewSiteUrl)` returns the `{ name: 'findDocument', description, parameters, handler }` shape. Description-builder iterates `collectionSchemas` slugs (mirrors `createDocument`).
- `parameters: { collection: z.string(), where: z.string().optional() (JSON string), id: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), depth: z.number().int().min(0).max(3).optional(), draft: z.boolean().optional() }`. If `id` is set, `findByID`; else `find` with parsed `where`.
- Handler stamps context, calls `payload.find{,ByID}` with `overrideAccess: false, user, req`, decorates draft docs via `decorateDraftResponse` (extracted helper), returns `textResponse` with structured JSON.
- `createDeleteDocumentTool(collectionSchemas)` similar. Handler calls `payload.delete({ collection, id, overrideAccess: false, user, req })`. No relationship walk (that's `safeDelete`'s job).
- `decorateDraftResponse(doc, collection, req)` extraction: move the draft-aware preview-URL logic from `src/draft-workflow.ts`'s `overrideResponse` into a pure function in `_helpers.ts`. `find-document.ts` calls it on each returned doc; same helper should also be reachable from `update-document.ts` / `create-document.ts` for consistency.

**Patterns to follow:**
- `src/tools/create-document.ts` and `src/tools/update-document.ts` shape.
- `src/draft-workflow.ts` `resolvePreviewUrl` for the URL-resolution logic (move alongside the helper).

**Test scenarios:**
- Happy path: `findDocument({ collection: 'posts', id: 'abc' })` → calls `payload.findByID` with `overrideAccess: false`, returns `textResponse` with the doc.
- Happy path: `findDocument({ collection: 'posts', where: '{"status":{"equals":"published"}}', limit: 10 })` → parsed where is forwarded to `payload.find`.
- Edge case: `where` is invalid JSON → returns text error response, no exception.
- Edge case: collection not in schemas → text error response listing valid slugs.
- Integration: draft collection result has `_status: 'draft'` → response includes `previewUrl` field via `decorateDraftResponse`.
- Edge case: collection has no `admin.livePreview.url` and no `admin.preview` → `previewUrl` is the generic admin-panel hint.
- Happy path: `deleteDocument({ collection: 'posts', id: 'abc' })` → calls `payload.delete` with `overrideAccess: false`, returns success text.
- Error path: `deleteDocument` against a doc that doesn't exist → text error response, not an exception.

**Verification:**
- Manual sandbox call via the MCP endpoint succeeds for find + delete on a draft-enabled collection.
- Existing `safeDelete` and `updateDocument` tests still pass — `decorateDraftResponse` extraction didn't regress them.

---

- U7. **Plugin entry rewrite + conflict detection**

**Goal:** Rewrite `src/index.ts` to drop the `mcpPlugin(...)` call and wire the new modules. Slim `src/draft-workflow.ts` to expose only `draftCollections` set and exclusion logic (no more `mcpCollections` shape). Add `src/conflict-detection.ts` to throw if `@payloadcms/plugin-mcp` is also registered or if the api-keys slug is taken.

**Requirements:** R6, R7 (wires the dispatcher), R10

**Dependencies:** U2, U3, U4, U5, U6

**Files:**
- Create: `src/conflict-detection.ts`
- Modify: `src/index.ts`
- Modify: `src/draft-workflow.ts`
- Test: `src/__tests__/conflict-detection.test.ts`
- Test: `src/__tests__/index-integration.test.ts` — boot a Payload mock, assert collections + endpoints + auth strategies are registered.

**Approach:**
- `conflict-detection.ts`:
  - `assertNoUpstreamPlugin(plugins)`: walk `incomingConfig.plugins`, throw `Error('payload-mcp-toolkit v0.4 is the standalone successor to @payloadcms/plugin-mcp. Remove mcpPlugin(...) from your plugins[] before upgrading.')` if any plugin's `.name` or function reference matches.
  - `assertNoSlugConflict(collections, slug)`: throw if a collection with `slug === 'payload-mcp-api-keys'` is already in `incomingConfig.collections` from another source (could be the upstream plugin's leftover or a user-defined collection).
- `index.ts` rewrite (skeleton):
  - Run conflict checks first.
  - Compute `collectionSchemas`, `blockNestingMap`, `draftCollections`, `previewSiteUrl` (existing logic).
  - Build the tools/prompts/resources arrays (existing factories — including new `find-document` and `delete-document`).
  - `incomingConfig.collections.push(createApiKeysCollection({ slug, userCollection }))`.
  - Add the bearer strategy to the user collection's `auth.strategies` (find or create the auth config; preserve existing strategies).
  - `incomingConfig.endpoints.push(...createMcpEndpoints({ initializeServer, allowedOrigins }))` where `initializeServer` is built by `createInitializeServer({ tools, prompts, resources, getApiKeyContext })` from U5.
  - Drop the `mcpPlugin(...)` call entirely. Drop `withMcp(...)` wrapping; just return `incomingConfig`.
- `draft-workflow.ts` slim:
  - Keep `getDraftBehavior`, `computeDraftCollections(collections, options): { draftCollections: Set<string>, excluded: Set<string> }`.
  - Remove `generateMcpCollectionConfigs`, `createOverrideResponse`, `resolvePreviewUrl` (moved to `_helpers.ts` per U6).
- `ContentToolkitOptions` (`src/types.ts`):
  - Add `auth?: { allowedOrigins?: string[] }` for CORS.
  - Add `apiKeyCollection?: { slug?: string; userCollection?: string }` (defaults `'payload-mcp-api-keys'` and inferred from `incomingConfig.admin.user`).
  - Existing options (`previewSite`, `draftBehavior`, `userCollection`, `exclude`) retained.

**Patterns to follow:**
- Existing `src/index.ts` flow (introspection → schemas → tool factories → register).
- `docs/solutions/architecture-patterns/payload-plugin-config-inference-2026-05-04.md` — additive-to-host-config rule.

**Test scenarios:**
- Happy path: `contentToolkitPlugin()` applied to a clean Payload config → `config.collections` includes `payload-mcp-api-keys`, `config.endpoints` includes POST + GET `/mcp`, the `userCollection`'s `auth.strategies` includes the bearer strategy.
- Error path: incomingConfig.plugins contains a function with `.name === 'mcpPlugin'` (or recognizable shape) → `contentToolkitPlugin()` throws with the migration message.
- Error path: incomingConfig.collections already contains `{ slug: 'payload-mcp-api-keys' }` from another source → throws with a slug-conflict message.
- Edge case: `incomingConfig.admin.user` set to a non-default user collection → strategy attaches to that collection.
- Edge case: user collection has existing `auth.strategies` → new strategy is appended, not replacing.
- Integration: register tools through the new initializer; a fake `tools/list` JSON-RPC call returns all expected tool names.
- Edge case: legacy v0.3 `draftBehavior` option still works as before (`always-publish` / `always-draft`).

**Verification:**
- Booting `dev/` with `contentToolkitPlugin()` and an MCP client (or curl) shows tools/prompts/resources via `tools/list`, etc.
- Adding `mcpPlugin` to `dev/payload.config.ts` `plugins[]` causes a startup error with the migration message.

---

- U8. **README rewrite, CHANGELOG, migration guide, version cut**

**Goal:** Rewrite `README.md` leading with the standalone story; add an "Upgrading from 0.3.x" section; ship `CHANGELOG.md` v0.4.0 entry; bump version to `0.4.0`; tag and trigger publish workflow.

**Requirements:** R12

**Dependencies:** U7

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `package.json` (version → `0.4.0`)

**Approach:**
- README structure:
  - Hero: "Schema-aware MCP plugin for Payload v3. AI-friendly authoring tools, draft workflow, scoped API keys."
  - **Install** — `pnpm add payload-mcp-toolkit`. No mention of `@payloadcms/plugin-mcp`.
  - **Configure** — single `contentToolkitPlugin()` call in `plugins[]`. Show the option shape including new `auth.allowedOrigins` and `apiKeyCollection`.
  - **API keys** — how to create, scope shape (with preset table), the `mcp_live_<...>` format, lifecycle fields.
  - **What it adds** — tool list (existing + `findDocument`, `deleteDocument`), prompts, resources.
  - **Draft workflow** — kept, but reframed: no longer "wires into upstream's mcpCollections," just "preview URLs are appended to draft responses."
  - **Upgrading from 0.3.x** — five concrete steps:
    1. Remove `mcpPlugin` from `plugins[]` (toolkit now standalone).
    2. Remove `@payloadcms/plugin-mcp` from your `package.json`.
    3. Existing API keys keep working zero-touch — first request migrates the row's scopes.
    4. New scopes shape: documented with examples.
    5. CORS defaults to no-browsers — set `auth.allowedOrigins` if you have a browser-based MCP client.
- CHANGELOG `## [0.4.0] - 2026-05-XX`:
  - **Added** — standalone plugin (drops `@payloadcms/plugin-mcp` peer dep), scoped per-key authz with role presets, lifecycle fields on api-keys, `findDocument` / `deleteDocument` polymorphic tools, plugin-conflict detection.
  - **Changed** — package owns `/api/mcp` endpoint, auth via Payload `auth.strategies`, scopes JSON field replaces upstream's dynamic `mcpAccessSettings` (silent migration on first request).
  - **Removed** — `@payloadcms/plugin-mcp` peer dependency. Wrapper-only options (none currently public).
  - **Migration** — link to README "Upgrading from 0.3.x" section.
- Bump `package.json` version `0.4.0-alpha.0` → `0.4.0`. The publish workflow on tag `v0.4.0` triggers `pnpm publish`.

**Patterns to follow:**
- Existing README structure and tone.
- CHANGELOG conventions (Keep-a-Changelog).

**Test scenarios:**
- Test expectation: none — pure docs + version metadata. Verification is reading the rendered README + CHANGELOG.

**Verification:**
- `pnpm build && pnpm test` passes.
- Manual `npm publish --dry-run` shows expected file list (no test files, no dev sandbox, includes `dist/`).
- Tag `v0.4.0` push triggers the publish workflow successfully.

---

## System-Wide Impact

- **Interaction graph:** every MCP request now routes through the toolkit's own endpoint → Payload's `auth.strategies` → `mcp-handler` → SDK dispatch → `registry.dispatch` → tool handler. No upstream plugin in the path. The `auth.strategies` addition affects the user collection's auth flow (only for requests carrying `Authorization: Bearer mcp_live_...` — others fall through to existing strategies).
- **Error propagation:** auth failures surface as HTTP 401 from Payload's strategy dispatcher (consistent with other strategies). MCP protocol errors return JSON-RPC errors with proper codes. Tool-execution errors return successful MCP results with `isError: true` (per spec). Audit log catches everything.
- **State lifecycle risks:** legacy-row migration writes once per row on first authenticated request. Concurrent first-requests against the same row could double-write — acceptable because the translator is deterministic. `lastUsedAt` writes are fire-and-forget; a slow DB write should not delay the request response.
- **API surface parity:** existing tools (`createDocument`, `updateDocument`, `patchLayout`, `publishDraft`, `safeDelete`, `searchContent`, `resolveReference`, `versions`, `uploadMedia`, `schedulePublish`) continue to work unchanged. `findDocument` and `deleteDocument` are net-new. `ContentToolkitOptions` gains `auth.allowedOrigins` and `apiKeyCollection`. No tool argument shape changes.
- **Integration coverage:** unit-mock tests (`vi.fn()` on `req.payload`) cover most paths. Manual sandbox verification needed for: end-to-end MCP request → tool result; legacy-row migration on first request; CORS behavior.
- **Unchanged invariants:** existing API-key plaintext format (`mcp_live_<...>`) — generation logic preserved. Existing `key` / `keyHash` columns preserved. Slug `payload-mcp-api-keys` preserved. Tool handler contract preserved (`(args, req, _extra) => McpTextResponse`). Draft preview URL semantics preserved (just moved into a shared helper).

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `mcp-handler` 1.x has surprises we haven't surfaced (pre-spike unknowns) | Day-1 spike (U4) is a smoke test against a stub tool. If `mcp-handler` is unfit, fall back to using `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` directly (one extra unit's work). |
| Legacy-row migration translator is wrong for some upstream-shape variant we haven't seen | Translator is a pure function with comprehensive fixture tests. Fall-through behavior on malformed input is "leave `scopes` null = full access" (logged), not auth failure. Worst case a user sees over-broad access until they re-scope manually — visible, not silent. |
| Plugin-conflict detection misses a shape we didn't anticipate | Detection is best-effort; relies on either the function's `.name` or the presence of the api-keys collection slug. If both checks miss, the symptom is a Payload boot error about duplicate collection slug — clearer than a silent corrupt state. |
| Existing toolkit users' tool factories break under the registration adapter | The adapter is the only contract change. Tests cover the existing 11 tool shapes. Risk is bounded. |
| SDK-version Zod incompatibility | Pin `@modelcontextprotocol/sdk ^1.18` (Zod v4 compatible). Pin `zod ^3.25 || ^4`. Document in README. |
| CORS-no-default breaks an existing user with a browser-based MCP client | Documented in upgrade guide. New `auth.allowedOrigins` option is the explicit opt-in. Logged as a breaking change in CHANGELOG. |
| `lastUsedAt` write storm under high-traffic keys | Fire-and-forget; no per-request cost. Could throttle in v0.5 if it shows up in metrics. |

---

## Documentation / Operational Notes

- README is the primary doc. Upgrade guide section is critical — most existing users will hit this.
- CHANGELOG entry doubles as the release notes.
- After v0.4 ships, capture two `/ce-compound` learnings:
  1. The `mcp-handler` 1.x adoption pattern for Payload plugins (helpful for future plugin authors who want MCP).
  2. The legacy-shape lazy-migration pattern (read-old, write-new on first lookup) — applicable to other plugin-upgrade situations.
- Operationally: monitor for spikes in legacy-translator log entries after v0.4 ships. A long tail suggests rows that haven't been hit yet; expected to taper within a few weeks of release.

---

## Post-Planning Findings (Codex second-opinion review, 2026-05-04)

A second-opinion read of the upstream code surfaced two findings worth recording before implementation. Neither blocks v0.4, but both should inform how the plan is communicated and what lands in v0.5.

### Finding 1 — Upstream architecture is more sophisticated than the brainstorm credited

The brainstorm framed upstream's converter pipeline as "wrong abstraction layer." A closer read shows the upstream team already shipped *three* pre-processing passes (`sanitizeJsonSchema`, `transformPointFieldsForMCP`, `simplifyRelationshipFields`) — each one a bug-specific patch against a known converter failure, with explicit comments documenting the rationale. The actual bug class isn't naive architecture: it's that the `z.record(z.any())` fallback path didn't get the integration testing the happy path got, so the fallback crashes downstream callers expecting `.shape` / `.partial()`.

**Implication for the plan:** the README upgrade-guide framing should be neutral, not contemptuous. The standalone fork is the right move *for this toolkit's value proposition*, but the upstream architecture is a defensible design that can be repaired — and a focused upstream PR (extending `simplifyRelationshipFields` to richText/blocks/upload + fixing the fallback's downstream contract) is a tractable contribution if anyone has the appetite. The brainstorm's "Alternatives considered → (b) Minimal upstream change request" was directionally right but more achievable than estimated.

### Finding 2 — JSON-blob input shape has a real UX cost in MCP-aware clients

Concretely: with upstream working, an AI tool call looks like `createPosts({ title: "hello", slug: "hello", status: "published" })`. With the toolkit's local-API approach, it looks like `createPosts({ collection: "posts", data: '{"title":"hello","slug":"hello","status":"published"}' })`.

For pure AI-to-AI use, modern LLMs handle JSON-as-string reliably. **For MCP clients that render tool schemas to users** (Claude Desktop's tool inspector, future admin-UI plugin playgrounds), they see one opaque `data: string` field instead of structured per-field UI. That's a real degradation for transparency, prefill, and client-side validation.

The v0.4 plan accepts this trade because the alternative — typed inputSchema per collection — is what crashes upstream. But there's a hybrid worth considering for v0.5: **per-field typed schemas for collections that contain only simple scalar fields (text/number/date/checkbox/email/select), JSON-blob fallback for collections with richText/blocks/upload/relationship-array.** That hybrid would recover most of the lost UX for a meaningful fraction of real-world collections without crashing on the expressive ones. Not free — it's effectively a better, more conservative `convertCollectionSchemaToZod` — but tractable. Captured in the future-work doc; not in v0.4 scope.

### Implications for v0.4 implementation

- **No code changes** — the plan stands as written.
- **README upgrade-guide tone** — frame the move as "owning the small remaining surface" rather than "upstream is broken." See U8 approach.
- **Tool description quality matters more under our shape than under upstream's.** Each tool's `description` is the AI's only schema affordance for the `data` field. Implementers should keep the description-builder patterns in `createDocument` / `updateDocument` (which list valid collection slugs) and consider documenting field shape inline in tool descriptions where it materially helps.
- **Audit log key fields should include the parsed `data`'s top-level keys** (sanitized — no values, just key names) so we can later analyze whether the prose-only shape is actually causing AI mistakes in the wild. Adjust U5's audit log spec accordingly during implementation.

---

## Sources & References

- **Origin document:** [docs/brainstorms/standalone-plugin-2026-05-04.md](../brainstorms/standalone-plugin-2026-05-04.md)
- **Future-work doc (parking lot):** [docs/brainstorms/standalone-plugin-future-work-2026-05-04.md](../brainstorms/standalone-plugin-future-work-2026-05-04.md)
- **Prior learning:** [docs/solutions/architecture-patterns/payload-plugin-config-inference-2026-05-04.md](../solutions/architecture-patterns/payload-plugin-config-inference-2026-05-04.md)
- Related code: `src/index.ts`, `src/draft-workflow.ts`, `src/tools/_helpers.ts`, `src/tools/create-document.ts`
- Upstream code (for reference, not dependency): `node_modules/@payloadcms/plugin-mcp/dist/endpoints/mcp.js`, `mcp/getMcpHandler.js`, `collections/createApiKeysCollection.js`
- External: https://github.com/vercel/mcp-handler — `mcp-handler` package
- External: https://github.com/modelcontextprotocol/typescript-sdk — MCP SDK
- External: https://payloadcms.com/docs/authentication/custom-strategies — Payload auth strategies
- External: https://payloadcms.com/docs/rest-api/overview — Payload custom endpoints
- External: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html — OWASP guidance on high-entropy tokens vs passwords
