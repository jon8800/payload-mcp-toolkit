---
title: MCP endpoint auth bypass and scopes.collections fail-open
module: payload-mcp-toolkit
date: 2026-05-05
category: security-issues
problem_type: security_issue
component: authentication
severity: critical
symptoms:
  - "POST /api/mcp dispatched to mcp-handler when req.user._mcpKey was absent, allowing unauthenticated tools/list and tools/call"
  - "A key with scopes.collections set for one collection could call updateDocument or deleteDocument on any other collection"
  - "Tools without a collection arg (searchContent, uploadMedia, resolveReference) bypassed scope checks under collection-scoped or read-only keys"
root_cause: missing_validation
resolution_type: code_fix
related_components:
  - tooling
tags:
  - mcp
  - payload
  - auth-bypass
  - scope-enforcement
  - bearer-auth
  - fail-closed
  - codex-review
---

# MCP endpoint auth bypass and `scopes.collections` fail-open

## Problem

`payload-mcp-toolkit` v0.4.0 shipped two compounding auth-bypass defects. The `POST /api/mcp` endpoint dispatched JSON-RPC traffic to `mcp-handler` without verifying the bearer auth strategy had hydrated `req.user._mcpKey`, and `assertScopeAllows` treated unmatched collections and collection-less tools as fully allowed. Together, an unauthenticated client could enumerate and invoke every MCP tool, and even valid keys could exceed their declared scope.

## Symptoms

- Unauthenticated `POST /api/mcp` with `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` returned the full tool catalog.
- Unauthenticated `tools/call` requests reached tool handlers and only failed (if at all) at Payload's collection access layer.
- A key scoped to `{ collections: { posts: ['read', 'update'] } }` could successfully `updateDocument` / `deleteDocument` against `pages`, `categories`, or any unlisted collection.
- A `read-only` preset key could call `uploadMedia` (a `create` action) because the tool carries no `collection` argument.
- Collection-only keys (no preset) could invoke account-wide tools like `searchContent` and `resolveReference`.

## What Didn't Work

- The bearer strategy in `auth.strategies` correctly returned `{ user: null }` on auth failure, but Payload only surfaces that to **collection-level** access — it does not refuse requests at custom endpoints. So `src/endpoint.ts` saw an anonymous request and kept going.
- Host/Origin guards in `endpoint.ts` blocked CSRF-shaped traffic but did nothing about missing credentials.
- `assertScopeAllows` in `src/registry.ts` used `effective = override ?? presetActions` and gated only on `if (effective && ...)`, so any path producing `undefined` (unknown collection, no preset, no collection arg) silently allowed the call.
- Treating "null scopes = full access" as a back-compat default meant the endpoint-level miss was instantly weaponizable instead of being caught downstream.

## Solution

### `src/endpoint.ts` — gate before dispatch

```ts
if (!getApiKeyContext(req)) {
  return jsonRpcError('Unauthorized: MCP API key required', -32001, 401)
}
```

Inserted immediately after the Host/Origin checks and **before** the per-request `mcp-handler` is constructed, so no tool registration or routing occurs for unauthenticated callers.

### `src/registry.ts` — fail-closed `assertScopeAllows`

```ts
if (collection) {
  if (!action) return { allowed: true }
  if (collectionsScope) {
    const override = collectionsScope[collection]
    if (!override) {
      return { allowed: false, reason: `Collection "${collection}" is not in this API key's allowed collections.` }
    }
    if (!override.includes(action)) {
      return { allowed: false, reason: `Action "${action}" on collection "${collection}" is not permitted by this API key's scope.` }
    }
    return { allowed: true }
  }
  if (presetActions && !presetActions.includes(action)) {
    return { allowed: false, reason: `Action "${action}" on collection "${collection}" is not permitted by this API key's preset.` }
  }
  return { allowed: true }
}

// No collection arg: tool acts at the account level.
if (action && presetActions && !presetActions.includes(action)) {
  return { allowed: false, reason: `Action "${action}" is not permitted by this API key's preset.` }
}
if (action && !presetActions && collectionsScope) {
  return { allowed: false, reason: `Tool "${toolName}" requires a collection argument under this API key's collection-scoped configuration.` }
}
```

Now `scopes.collections` is a strict whitelist, presets gate account-wide tools, and every branch ends in either explicit allow or explicit deny.

## Why This Works

Defense in depth: the endpoint gate ensures no anonymous request ever reaches tool dispatch, so the registry never has to reason about a `null` key. The registry rewrite then assumes hostile inputs and defaults to deny — unknown collections, missing presets, and action mismatches all reject. Either layer alone would have stopped the unauthenticated bypass; both together mean a future regression in one is contained by the other. Crucially, the "null scopes = full access" back-compat default is no longer reachable from an unauthenticated request, and authenticated keys can no longer escape their declared collection set.

## Prevention

- **For any custom Payload endpoint that relies on `auth.strategies`, gate `req.user` (and any plugin-specific context) at the top of the handler.** Payload's `auth.strategies` hydrate `req.user` — they do **not** refuse unauthenticated requests at the endpoint layer. Custom endpoints must check explicitly.
- **Treat scope/permission checks as whitelists with explicit allow/deny on every branch.** Never use `if (effective && ...)` patterns where `undefined` silently permits.
- **Forbid back-compat "null = full access" defaults on security-sensitive paths** — or contain them behind an upstream gate that guarantees authenticated context.
- **Map every tool/action to a required `(action, collection?)` pair** at registration time so account-wide tools can't bypass per-collection scoping.
- Regression tests to add when building this kind of plugin:
  - Unauthenticated `tools/list` and `tools/call` must return 401.
  - A `posts`-only key must be denied on `pages`.
  - A `read-only` preset must be denied on `uploadMedia`.
  - A collections-only key (no preset) must be denied on `searchContent`.
- Consider an exhaustiveness assertion (e.g. `assertNever`) so every code path in the scope evaluator must end in an explicit decision.

## Related

- `docs/plans/2026-05-04-001-feat-standalone-mcp-plugin-v04-plan.md` — the plan that introduced these decisions. The plan's R3 ("Auth via `auth.strategies`, not endpoint middleware") and the scopes-JSON description are now partially superseded: `auth.strategies` is necessary but not sufficient (custom endpoints still need explicit gating), and the scopes shape needs whitelist semantics, not fallthrough.
- `docs/brainstorms/standalone-plugin-2026-05-04.md` — origin brainstorm where the scoped-authz model was first sketched.
- `docs/brainstorms/standalone-plugin-future-work-2026-05-04.md` — admin-panel future work that will inherit the corrected fail-closed semantics.
- Commit `2e848ab` — the actual fix.
