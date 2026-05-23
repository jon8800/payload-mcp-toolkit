---
title: Scope bypass on account-routed tools + excluded-globals leak via blockNesting
module: payload-mcp-toolkit
date: 2026-05-23
category: security-issues
problem_type: security_issue
component: authentication
symptoms:
  - "Key with { preset: 'admin', collections: { posts: ['read'] } } could searchContent across every collection, resolveReference into unlisted collections, and uploadMedia outside the whitelist"
  - "options.exclude.globals removed a global from availableGlobals and the globals://schema resource but patchGlobalLayout still exposed the excluded slug in its enum, and blocks://nesting leaked its block-field metadata"
  - "dev/app importMap registered CollectionScopesMatrix only — opening API Keys admin under Custom preset failed to resolve payload-mcp-toolkit/client#GlobalScopesMatrix"
root_cause: scope_issue
resolution_type: code_fix
severity: high
related_components:
  - tooling
tags:
  - mcp
  - payload
  - scope-enforcement
  - account-tools
  - exclude
  - globals
  - block-nesting
  - codex-review
---

# Scope bypass on account-routed tools + excluded-globals leak via blockNesting

## Problem

`payload-mcp-toolkit` v0.6.0 — shipped after the original auth-bypass fix in v0.4.1 — re-opened the scope-bypass surface from a different angle. With globals support landed, the policy module now routed tools across three kinds (`collection`, `global`, `account`). The account branch had a remaining gap: when a key combined a `preset` with explicit `collections` / `globals` overrides, account-routed tools (`searchContent`, `resolveReference`, `uploadMedia`) only consulted the preset and ignored the resource whitelist, broadening the key well past its declared scope. A second, narrower defect: `options.exclude.globals` was applied at most consumer sites but `buildBlockNestingMap` ran against the unfiltered globals list, so excluded globals leaked through `patchGlobalLayout`'s slug enum and the `blocks://nesting` resource body. A third UX defect: the dev import map did not register the new `GlobalScopesMatrix` client component, so the API Keys admin view broke under the Custom preset.

## Symptoms

- A key with `{ preset: 'admin', collections: { posts: ['read'] } }` correctly rejected `findDocument` against `pages` but happily ran `searchContent` (every collection), `resolveReference` (any slug), and `uploadMedia` (write into any media collection).
- The same pattern held with `globals` overrides: a key narrowed to one global still got full account-tool access.
- Calling `patchGlobalLayout` against an excluded global like `secret-config` succeeded because the tool's slug enum was derived from `blockNesting`, which was built before `excludeGlobals` was applied.
- The `blocks://nesting` resource body contained `ownerType: "global"` edges for excluded globals, leaking field-shape metadata about content the operator deliberately hid.
- Loading the API Keys admin under the Custom preset in the dev app threw an import-map resolution error for `payload-mcp-toolkit/client#GlobalScopesMatrix`.

## What Didn't Work

- The v0.4.1 fix closed the original "collection-only key calls account tool" gap by adding an explicit `if (scopes.collections || scopes.globals) deny` clause to `checkAccount`. That clause only fired when no preset was present (`!presetActions`), so the preset-plus-override combination — added in v0.6.0 with the `globalScopes` axis — fell through to `presetActions` and was treated as fully allowed.
- `exclude.globals` propagated correctly through `exposedGlobalSchemas`, `globalsBySlug`, and the api-keys `availableGlobals` clientProps, so a `grep`-based audit suggested exclusions were honored everywhere. The leak only surfaced via the `patchGlobalLayout` factory's enum, which was indirectly derived from `blockNesting` — a single call site that did not consult the exclusion sets.
- Adding `disabled: true` on `secret-config` to hide it from `patchGlobalLayout` would have worked but is the wrong fix — `exclude.globals` is the documented exclusion mechanism and must be authoritative.
- Treating the dev import map as a generated artifact and ignoring it: Payload v3 regenerates this file via `payload generate:importmap`, but the committed dev app is the only way a developer working on the plugin can exercise the admin UI, so a stale committed copy is a real bug.

## Solution

### `src/scope/policy.ts` — deny account tools whenever a resource override exists

Hoist the resource-override branch above the preset branch. An account-level tool spans the whole site by design; whenever a key carries an explicit `collections` or `globals` map it must be denied, regardless of how permissive the preset is.

```ts
function checkAccount(
  scopes: KeyScopes,
  toolName: string,
  toolAction: ReadonlyMap<string, CollectionAction>,
): ScopeDecision {
  const action = toolAction.get(toolName)
  const presetActions = scopes.preset ? PRESET_ACTIONS[scopes.preset] : undefined

  // Explicit resource override is the tightest signal: account-level tools
  // span every collection (searchContent across all, uploadMedia into any
  // media coll, etc.) and would broaden the key beyond the whitelist
  // regardless of preset. Deny account tools whenever explicit scopes exist.
  if (scopes.collections || scopes.globals) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is denied for keys with explicit collection or global scopes — account-level tools would broaden access beyond the whitelist.`,
    }
  }

  if (presetActions) {
    if (action && !presetActions.includes(action)) {
      return { allowed: false, reason: `Action "${action}" is not permitted by this API key's preset.` }
    }
    return { allowed: true }
  }

  return { allowed: true }
}
```

### `src/index.ts` — build `blockNesting` from exclusion-filtered inputs

Move the `computeDraft*` calls above the `buildBlockNestingMap` call and pass filtered arrays in:

```ts
const { draftCollections, excluded } = computeDraftCollections(...)
const { draftGlobals, excluded: excludedGlobals } = computeDraftGlobals(...)

const exposedCollectionsForNesting = collections.filter((c) => !excluded.has(c.slug))
const exposedGlobalsForNesting = globals.filter((g) => !excludedGlobals.has(g.slug))
const blockNesting = buildBlockNestingMap(
  exposedCollectionsForNesting,
  exposedGlobalsForNesting,
  allBlocks,
)
```

### `dev/app/(payload)/admin/importMap.js` — register `GlobalScopesMatrix`

Add the import and entry alongside `CollectionScopesMatrix`:

```js
import { GlobalScopesMatrix as GlobalScopesMatrix_60f30f580e97936338e112b8b2cc7161 } from 'payload-mcp-toolkit/client'
// …
"payload-mcp-toolkit/client#GlobalScopesMatrix": GlobalScopesMatrix_60f30f580e97936338e112b8b2cc7161,
```

## Why This Works

The account-tool defense is structurally the same shape as the v0.4.1 fix, just hoisted above the preset branch. Account-level tools have no `resource` argument — they sweep the entire site by design (searchContent across every collection, uploadMedia into whatever the operator points it at, resolveReference into arbitrary slugs). Once the key declares an explicit whitelist via `collections` or `globals`, there is no way to honor that whitelist at call time for a tool that takes no resource argument. The only correct posture is "deny, ask the operator to use a collection-scoped tool instead." Putting that check above the preset branch closes the combinatorial case the original fix missed.

The blockNesting fix is a pure data-flow correction: the exclusion sets existed earlier in the function, but one downstream consumer (`buildBlockNestingMap`) ran before they were computed and was therefore fed raw inputs. Reordering and filtering at the call site fixes every downstream consumer (`patchGlobalLayout` factory's enum, the `blocks://nesting` resource body) without touching the nesting builder itself.

The dev import map fix is mechanical — Payload v3's admin UI loads client components through an import map manifest, and adding the matrix field without adding the corresponding manifest entry breaks the admin view at runtime.

## Prevention

- **Account-routed tool tests must cover preset + override combinations.** The original v0.4.1 fix had tests for "collection-only key, no preset" and "preset alone." The combinatorial case (`{ preset, collections }` together) was the gap. Regression tests added in `src/__tests__/registry.test.ts`:

  ```ts
  it('explicit collections override denies account tools even under admin preset', () => {
    const scopes = { preset: 'admin' as const, collections: { posts: ['read' as const] } }
    expect(assertScopeAllows(scopes, 'searchContent', undefined).allowed).toBe(false)
    expect(assertScopeAllows(scopes, 'resolveReference', undefined).allowed).toBe(false)
    expect(assertScopeAllows(scopes, 'uploadMedia', undefined).allowed).toBe(false)
  })
  ```

- **Exclusion lists must be applied before any downstream derivation.** Whenever an `options.exclude.*` feature is added, audit every consumer that reads the raw collection/global list and ensure each one consults the exclusion set. A `grep` for the exclusion set's variable name is a cheap audit. The structural fix here was to push the exclusion computation up so it is impossible for a derivation to run before it.

- **Dev import map drift.** Whenever a new client component is added to a field's `admin.components.Field`, regenerate the dev import map (`payload generate:importmap`) and commit the change in the same PR. Treat `importMap.js` as code that ships with the feature, not as a generated side-effect.

- **Two-axis scope policy needs scenario-table tests, not unit tests.** The bug surfaced because `(preset × resource-override)` is a 2D space and the original tests only covered the axes individually. When a policy has multiple inputs that can combine, table-drive the tests over the cross product.

## Related Issues

- [[mcp-auth-bypass-and-scope-fail-open-2026-05-05]] — original v0.4.1 fix for the unscoped account-tool bypass; this doc extends the same family with the preset-plus-override combinatorial case and the exclusion-leak path.
- [[multi-resource-scope-routing-2026-05-23]] — architecture pattern doc for the collection/global/account routing model that this fix reinforces.
- [[additive-feature-evolution-payload-plugin-2026-05-23]] — additive-evolution pattern that produced the v0.6.0 globalScopes axis; this learning is the cautionary tail: adding a new axis to a policy module requires re-auditing every branch that consumed the old axes.
