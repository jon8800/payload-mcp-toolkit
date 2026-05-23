---
title: Evolve a Payload plugin additively — conditional tool factories that return null, optional collection-factory args, and JSONB-typed scope columns
date: 2026-05-23
category: docs/solutions/architecture-patterns
module: payload-mcp-toolkit
problem_type: architecture_pattern
component: plugin-architecture
severity: medium
applies_when:
  - Adding a new feature axis (resource kind, tool family, scope dimension) to a published Payload plugin without breaking direct callers
  - Designing tool factories whose registration should depend on whether the host config opts into a feature (drafts, blocks, versions)
  - Choosing between Payload `array` fields and `json` fields for scope/permission storage that needs to migrate cleanly
  - Keeping a plugin's MCP `tools/list` surface scoped to what the host config actually supports
tags: [payload-cms, plugin-evolution, non-breaking-changes, conditional-registration, jsonb-storage, drizzle-migration]
---

# Evolve a Payload plugin additively — conditional tool factories that return null, optional collection-factory args, and JSONB-typed scope columns

## Context

`payload-mcp-toolkit` v0.6 added globals support — a new resource kind, six new tools, a new scope axis, a new admin matrix table. Adding all that without forcing operators into a coordinated upgrade is the difference between a 0.x version bump and a major-version migration. Three patterns made the additive framing actually hold up under implementation pressure.

The temptation in each case was to force the new feature into existence:
- Register every new global tool unconditionally and let it throw on hosts without globals.
- Make `availableGlobals` a required arg on `createApiKeysCollection` for symmetry with `availableCollections`.
- Model `globalScopes` as a Payload `array` field (the "natural" shape) and let the join-table migration happen.

Each of those choices breaks the additive contract somewhere — `tools/list` pollution for hosts that don't use globals, factory call-site breakage for direct callers, or a multi-table migration that downstream operators have to coordinate. The patterns below preserve "drop-in upgrade" while still letting the new feature be first-class for hosts that adopt it.

## Guidance

### 1. Conditional tool factories return `null`; the plugin entry filters

For tools that only make sense under specific host config (drafts enabled, blocks fields present, multiple of a resource kind):

```ts
export function createPublishGlobalDraftTool(draftGlobals: Set<string>) {
  if (draftGlobals.size === 0) return null   // host has no draft-enabled globals
  // ...build the factory output
}

export function createPatchGlobalLayoutTool(...) {
  if (nestingByGlobalField.size === 0) return null   // no global has blocks fields
  // ...
}
```

The plugin entry composes a flat array of factory outputs and filters falsy values before passing it to the registrar:

```ts
const tools = [
  createFindDocumentTool(...),
  createUpdateDocumentTool(...),
  createFindGlobalTool(...),         // unconditional
  createPublishGlobalDraftTool(...), // null if no draft globals
  createPatchGlobalLayoutTool(...),  // null if no global has blocks
  // ...
].filter(Boolean)
```

**Why this shape over alternatives:**

- **Vs. an outer `if`:** the gating logic lives next to the tool that knows what it needs. Adding a new conditional tool is a one-file change.
- **Vs. throwing in the handler:** `tools/list` shouldn't advertise tools the host can't service. An LLM seeing `publishGlobalDraft` in the catalog will call it; getting a "this host has no draft globals" error back is worse UX than not seeing the tool at all.
- **Vs. a registration callback:** keeps the factory pure. The entry orchestrates; the factory decides.

**Test invariant:** every conditional factory has at least one test asserting `null` for the negative case and a defined output for the positive case. Add this to your test scaffold; it's the only thing that catches drift between the gating condition and the dependency the tool actually has.

### 2. Optional `available<Kind>` args with `[]` default

```ts
interface CreateApiKeysCollectionOptions {
  availableCollections?: string[]   // existed in v0.5
  availableGlobals?: string[]       // added in v0.6 — OPTIONAL
  // ...
}
```

When `createApiKeysCollection` is called by the plugin entry, both args are supplied. When called directly by a host that pre-dates the new feature, only the old args are passed. Default `[]`, and the admin matrix branches on `availableGlobals?.length > 0` to render (or not) the second matrix table.

**Why not "required for symmetry":** the plugin entry can always supply the arg, but direct callers of `createApiKeysCollection` (hosts customising the API-keys collection further) would break compile-time on the day they upgrade. Optional + sensible default keeps the upgrade path "edit `package.json`, run install" instead of "edit `package.json`, find every call site, run install."

The cost of "optional" is one undefined check in the matrix component. The cost of "required" is a doc note operators have to find, with no tooling support if they miss it.

### 3. JSON-typed scope storage, never `array` fields

```ts
const globalScopesField: Field = {
  name: 'globalScopes',
  type: 'json',                          // NOT type: 'array'
  defaultValue: '[]',
  admin: {
    condition: (data) => isCustomPreset(data) && availableGlobals.length > 0,
    components: { Field: '...GlobalScopesMatrix...' },
  },
}
```

The stored shape is `Array<{ global: string; actions: ('read' | 'update')[] }>` — exactly what a Payload `array` field would model — but as a single JSONB column rather than a join table. This is the load-bearing precedent from v0.5's `collectionScopes`.

**Why JSONB-as-storage matters:**

- **Migration is one additive column.** `ALTER TABLE payload_mcp_api_keys ADD COLUMN global_scopes jsonb DEFAULT '[]'`. Drizzle's `push: true` auto-applies in dev; production gets a one-line migration that won't conflict with anything.
- **An `array` field generates a join table.** New table, new constraints, new indexes, a multi-statement migration, and recovery semantics on rollback that operators have to think about. None of that buys anything when the data is always read in lockstep with the parent row.
- **Custom matrix renderer needs the data shape, not Payload's row helpers.** The `GlobalScopesMatrix` React component renders a denormalised matrix; it doesn't need the row-iteration affordances Payload's `array` field provides.
- **Auth-hot-path query stays a single row read.** `composeScopes` runs on every authenticated request. JSONB keeps the API-key SELECT to one row with no joins.

**When `array` is the right choice instead:** when the rows are mutated independently of the parent (audit log entries, version snapshots, attachments). Scope overrides are always edited and read with the parent key — JSONB is correct.

**Migration story this enables:** the plan deliberately doesn't ship migration files. The host project owns its `migrations/` directory. The CHANGELOG instructs operators to run `pnpm payload migrate:create` once after upgrading, which produces a single additive-column migration that's safe to apply in any order relative to other host migrations. This only works because the storage is JSONB; an `array` field would generate a multi-table migration whose ordering matters.

## Why This Matters

**Failure mode if conditional factories throw instead of returning `null`:** `tools/list` advertises every tool unconditionally. An LLM connected to a host with no draft globals sees `publishGlobalDraft`, calls it on the first content-update task, and gets a runtime error that the human has to translate ("the host doesn't have draft globals" — which the LLM had no way to know from the catalog). Half the value of MCP's typed surface is that the catalog tells the consumer what's available.

**Failure mode if `availableGlobals` is required:** the day v0.6 ships, every host customising the API-keys collection (a documented extension point) gets a TypeScript error on a working call site. The upgrade message is "non-breaking additive release" — a TS error breaks that promise. Operators learn not to trust the framing.

**Failure mode if `globalScopes` is an `array` field:** the v0.6 → v0.5 rollback path goes from "drop a column" to "drop a join table, restore any rows referencing it." The "additive, non-breaking" framing assumes operators can rollback without coordinating data movement. JSONB preserves that property.

Together, these patterns are the difference between a 0.6.0 release operators install in their lunch break and a release operators schedule for next sprint. The constraints are mutually reinforcing: optional factory args let the matrix component be feature-gated, conditional registration keeps the tool catalog honest, JSONB storage keeps the migration footprint minimal — and each one reinforces the "additive" framing the others depend on.

## How to Apply

When adding the next feature axis (e.g. `redirects`, `media-folders`, `forms`):

1. **Tool factories.** Every new factory tied to a host-config opt-in returns `null` when the opt-in is absent. Filter in the plugin entry. Add the `null`-case regression test.
2. **Factory args.** New `available<Kind>?: string[]` args are optional with `[]` default. Existing call sites compile unchanged. Document in CHANGELOG as additive.
3. **Storage.** New per-resource scope override is a `type: 'json'` field, default `'[]'`, with a custom admin component. NOT a Payload `array` field. The migration is one additive JSONB column.
4. **`tools/list` honesty.** If a host has zero of the new resource kind, the new tools should not appear. If the resource kind is present but the feature isn't (e.g. globals exist but none have drafts), the feature-specific tools should not appear. The catalog is a contract with the LLM; advertising tools that immediately error is the worst-case UX.

When porting these patterns to a different framework plugin:

- "Conditional factory returns null + entry filters" generalises wherever the registry expects a flat list. The pattern doesn't require Payload-specifics.
- "Optional args with sensible defaults" is a discipline applied at the boundary of *every* exported factory, not a one-off. Audit boundary signatures on each release for accidental requireds.
- "JSONB over `array` for scope storage" generalises to any ORM where you can choose between a typed column and a relation. The decisive question: does the child data ever get read/mutated without the parent? If no, single-column storage every time.

## Related

- [[multi-resource-scope-routing-2026-05-23]] — the scope evaluation layer this pattern stores data for. The JSONB column feeds `composeScopes`; the conditional factories register the tools `assertScopeRegistryInvariant` validates.
- [[block-nesting-map-unified-ownership-2026-05-23]] — companion introspection pattern; both share the "introspect host config, derive feature presence, gate registration" pipeline.
- [[payload-plugin-config-inference-2026-05-04]] — the broader stance these patterns serve: read what the host declares, register conditionally, never demand the operator restate.
- `src/index.ts` — plugin entry; tool array composition + filtering.
- `src/tools/publish-global-draft.ts`, `src/tools/patch-global-layout.ts`, `src/tools/global-versions.ts` — examples of `return null` conditional factories.
- `src/api-keys.ts` — `globalScopesField` (JSONB shape) and `availableGlobals` optional arg.
- `docs/plans/2026-05-12-001-feat-globals-support-plan.md` — the plan; "System-Wide Impact" section enumerates the additive surface.
