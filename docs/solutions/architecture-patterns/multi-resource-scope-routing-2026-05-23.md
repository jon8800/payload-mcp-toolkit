---
title: Route MCP tool scopes through three disjoint sets with a boot-time invariant, asymmetric per-resource presets, and a widened deny-all sentinel
date: 2026-05-23
category: docs/solutions/architecture-patterns
module: payload-mcp-toolkit
problem_type: architecture_pattern
component: authentication
severity: high
applies_when:
  - Extending a permissioned tool surface to a second (or Nth) resource kind that shares some — but not all — actions with the first
  - Designing scope/permission systems where different resource kinds carry different blast radii (singletons vs. per-document)
  - Refactoring a fail-closed scope evaluator to handle multiple resource axes without re-introducing the fail-open holes the first axis already closed
  - Adding new tools to a registry where "forgot to wire it up" should fail at boot, not at request time
tags: [payload-cms, mcp, scope-enforcement, fail-closed, preset-asymmetry, registry-invariant, blast-radius]
---

# Route MCP tool scopes through three disjoint sets with a boot-time invariant, asymmetric per-resource presets, and a widened deny-all sentinel

## Context

`payload-mcp-toolkit` v0.5 had a single scope axis: collections. `assertScopeAllows(scopes, toolName, collection?)` looked up the action in one `TOOL_TO_ACTION` map, gated it against `scopes.collections` or `scopes.preset`, and called it done. Account-level tools (`searchContent`, `uploadMedia`, `resolveReference`) — which carry no collection arg — fell through an implicit "no resource = account-level" branch.

v0.6 added globals. Globals are singletons (no `id`, no `create`, no `delete`), so they share `read`/`update` with collections but not the full action set. Three superficially attractive designs all turned out wrong:

1. **One unified action map.** Forces every entry to carry a discriminator and re-introduces the v0.4 fail-open pattern the security review (`mcp-auth-bypass-and-scope-fail-open-2026-05-05.md`) had just closed: `if (effective && ...)` branches where `undefined` silently allows.
2. **Tool-name-driven implicit routing with the arg still called `collection`.** Every denial message would say `Collection "siteSettings"…` for global denials, and the audit log's `collectionArg` field would misreport global operations as collection operations — invisible to SIEM rules.
3. **Symmetric presets across resource kinds.** Editor-tier keys could write globals as freely as collections, even though a single bad write to `site-settings.siteName` rewrites every page that consumes it. An LLM hallucinating "fix the site title" has a one-shot path to vandalism on every page, with no per-document containment to fall back on.

This skill captures the three-decision cluster that resolved this — they are co-load-bearing and have to be applied together, or the fail-closed contract regresses on the new axis.

## Guidance

### 1. Three disjoint routing sets, validated at boot

Don't try to encode "which scope map does this tool consult?" inside a single record. Use three module-scope sets and resolve at request time:

```ts
export const TOOL_TO_ACTION:        Record<string, CollectionAction> // per-collection
export const TOOL_TO_GLOBAL_ACTION: Record<string, GlobalAction>     // per-global
export const ACCOUNT_LEVEL_TOOLS:   ReadonlySet<string>              // no resource arg

export function resolveResourceKind(toolName: string): ResourceKind | null {
  if (toolName in TOOL_TO_ACTION) return 'collection'
  if (toolName in TOOL_TO_GLOBAL_ACTION) return 'global'
  if (ACCOUNT_LEVEL_TOOLS.has(toolName)) return 'account'
  return null  // fail-closed at request time
}
```

`assertScopeAllows` takes `resourceKind` as a parameter rather than re-deriving it inside the function. Three reasons:

- **Audit log correctness.** `targetKind: 'collection' | 'global' | 'account'` is populated from the routing lookup at the call site; denials report the correct resource type instead of mislabelling globals as collections.
- **Error message correctness.** Reason strings interpolate the kind (`Global "X"…` vs. `Collection "X"…` vs. `Action "X"…` for account-level).
- **Disjointness is enforceable.** A tool in two sets is ambiguous — there's no defensible auto-resolution. Making it a boot-time error forces the operator to decide.

Pair this with a plugin-init invariant:

```ts
export function assertScopeRegistryInvariant(toolNames: string[]): void {
  // every name must appear in exactly one of the three sets
  // missing → "forgot to register" → fail boot with the offender named
  // duplicate → ambiguous routing → fail boot with the offender named
}
```

Called once from the plugin entry after the tool list is assembled. A registered-but-unrouted tool is the single most common drift mode when adding new tools, and the cost of catching it at boot instead of at the first denied request is zero.

**Belt-and-braces:** `resolveResourceKind` returning `null` at request time still produces a denial (`Tool "X" has no registered scope mapping`), so a future regression that disables the boot check still fails closed.

### 2. Preset semantics are per-resource-kind, not uniform

The `editor` preset means different things on different resource axes:

```ts
const PRESET_ACTIONS:        Record<ScopePreset, CollectionAction[]> = {
  'read-only': ['read'],
  editor:      ['read', 'create', 'update'],   // editor writes collections
  admin:       ['read', 'create', 'update', 'delete'],
}

const PRESET_GLOBAL_ACTIONS: Record<ScopePreset, GlobalAction[]> = {
  'read-only': ['read'],
  editor:      ['read'],                        // editor is READ-ONLY on globals
  admin:       ['read', 'update'],
}
```

**Why:** preset names express *role intent*, not action lists. "Editor" means "someone who edits content" — and the content an editor edits is per-document. Globals are site-wide config; promoting them to write under the same role conflates two responsibilities that real organisations separate (content editors vs. site admins). Blast radius is the deciding axis:

- Collection write: scoped to one document. An LLM mistake breaks one page.
- Global write: site-wide on a single write. An LLM mistake rewrites every consumer.

`admin` keys retain full global write access. Custom keys with explicit `globalScopes` retain whatever the operator declares. The asymmetry only bites the `editor` preset.

**How to extend to a 3rd / 4th resource kind:** add a peer `PRESET_<KIND>_ACTIONS` map and decide for each preset whether the new kind warrants the same actions as collections, fewer, or more. The rule is "decide by blast radius, not by analogy." Don't reach for a unified map that flattens this — the asymmetry is the value.

### 3. Widened deny-all sentinel across every axis

`composeScopes` has a fail-closed sentinel for a specific UX trap: an operator selects `preset: 'custom'` in the admin UI, doesn't fill in any override fields, and saves. The natural-feeling intent is "no overrides means no access yet" — but the v0.4 fall-through ("no scopes set = full access") would broadcast every tool to that key.

The sentinel:

```ts
if (
  presetRaw === 'custom' &&
  !hasCollectionScopes &&
  !hasGlobalScopes &&
  !hasToolAllow &&
  !hasToolDeny
) {
  return { collections: {}, globals: {}, tools: { allow: [] } }
}
```

Three properties make this load-bearing:

- **Only fires on Custom.** Other presets still resolve to their action lists; a `'read-only'` key with empty overrides is not the same configuration as a Custom key with empty overrides.
- **Requires EMPTY on every override axis.** Partial-override Custom keys (only `collectionScopes`, only `toolAllow`) are honoured as written. The sentinel is "operator forgot to fill anything in," not "operator filled in one axis."
- **Returns empty whitelists, not undefined.** `collections: {}` is a whitelist with zero entries — every collection denied. `tools: { allow: [] }` is an allow-list with zero entries — every account-level tool denied. Returning `undefined` would re-enter the "no scopes = allow" fall-through.

**How to extend when adding a new resource axis:** the sentinel widens in lockstep. Add the new axis to both the predicate (`!has<NewAxis>Scopes`) and the returned shape (`<newAxis>: {}`). Without the widening, a Custom key with empty everything would fail-open on the new axis — the exact regression the sentinel was added to prevent, on a new dimension.

### 4. Tools.allow without a resource scope is a deny

Independent of the sentinel, the per-resource branches in `assertScopeAllows` close one more latent hole:

```ts
if (!collectionsScope && !presetActions) {
  return {
    allowed: false,
    reason: `Tool "${toolName}" requires an explicit collection scope or preset on this API key.`,
  }
}
```

A key with `tools: { allow: ['updateDocument'] }`, no `collections` map, and no preset would otherwise broadcast `updateDocument` across every collection. The fix is symmetric across collections and globals. This is a security tightening over v0.5's collection behaviour, applied to both axes simultaneously.

## Why This Matters

**Failure mode if you skip the three-set split:** every new tool name registered without a routing entry silently falls through to "no action → allow." The maintainer adds `archiveDocument`, ships, and discovers six months later that read-only keys can archive anything. The boot-time invariant turns this into a 5-second feedback loop.

**Failure mode if you skip the asymmetric presets:** the v0.5 `editor` preset semantics extend mechanically to globals via a single shared action map. Day one of v0.6, every editor-tier key in the wild can write site-wide config. There is no per-document containment to undo this; the only path to recovery is rotating every editor key.

**Failure mode if you skip the widened sentinel:** the operator who selects Custom + saves-immediately is the same person on every Payload deployment. They will exist, they will hit Save with empty fields, and v0.5's collections-axis sentinel already exists to catch them. Not widening it for globals means the same UX mistake fails differently on the new axis — confusing, and a P1 escape.

**Compounding correctness:** the three pieces work as defense in depth. The boot invariant catches registration drift. The per-resource preset maps prevent role-by-analogy escapes. The sentinel catches UX traps in the admin form. Skipping any one re-opens a class of failures the other two can't catch.

## How to Apply

When adding a new resource kind (e.g. `forms`, `redirects`, `media-folders`) to this plugin:

1. **Add a new routing set.** `TOOL_TO_<KIND>_ACTION: Record<string, <Kind>Action>` in `src/registry.ts`. Add to the `resolveResourceKind` branch. Update `ResourceKind` type union.
2. **Add a new preset map.** `PRESET_<KIND>_ACTIONS`. Decide per-preset by blast radius, not by analogy with collections.
3. **Add a new `check<Kind>` function.** Copy `checkCollection` or `checkGlobal`; preserve the fail-closed pattern — every branch ends in explicit allow or explicit deny, no `if (x && ...)` patterns where `undefined` silently passes.
4. **Widen the sentinel.** `composeScopes`: add `!has<Kind>Scopes` to the predicate AND `<kind>: {}` to the returned shape. Update tests.
5. **Update the audit log shape.** `targetKind` union gains the new value. Document in CHANGELOG if log queries are downstream.
6. **Update `assertScopeRegistryInvariant`.** It picks up the new set automatically because it iterates over names — but add a test exercising membership in the new set.

When porting this pattern to another framework plugin:

- Treat the three-set split as the default. Even if you start with one resource kind, name the set with the kind in it (`TOOL_TO_DOCUMENT_ACTION`) — the rename cost when the second kind arrives is what makes teams cheat.
- Treat per-resource preset maps as the default. Even if today's presets happen to be uniform, the named maps document that uniformity is a choice rather than an assumption.
- The sentinel pattern generalises to any "operator selected a special mode but didn't fill it in" UX. The principle: a UI sentinel value (`'custom'`) should never become the runtime mode; it gates the override pathway, and an empty override pathway is fail-closed, not fall-through.

## Related

- [[mcp-auth-bypass-and-scope-fail-open-2026-05-05]] — the v0.4 fail-open class the sentinel and the per-resource fail-closed branches close. The widened sentinel is the same pattern applied symmetrically to a new axis.
- [[payload-plugin-config-inference-2026-05-04]] — the introspection-from-host-config pattern that produces the `availableGlobals` array the matrix consumes. Per-resource scope routing only works because the toolkit reads what globals the host declares; it doesn't ask the operator to list them twice.
- [[block-nesting-map-unified-ownership-2026-05-23]] — companion pattern for unifying composition lookups across resource kinds while preserving collision detection.
- `docs/plans/2026-05-12-001-feat-globals-support-plan.md` — the plan that introduced these decisions, including the architectural review counter-arguments that the security-blast-radius case overrode.
- `src/registry.ts` — current implementation; the three sets, the invariant, and the three `check*` functions live in one file by design (they share the fail-closed contract).
- `src/auth-strategy.ts` — `composeScopes` and the widened deny-all sentinel.
