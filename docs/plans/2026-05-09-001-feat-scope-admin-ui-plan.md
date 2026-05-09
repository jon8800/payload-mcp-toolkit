---
title: "feat: Friendly scope admin UI for API keys"
type: feat
status: planned
date: 2026-05-09
---

# feat: Friendly scope admin UI for API keys

## Summary

Replace the single `scopes` JSON textarea on the `payload-mcp-api-keys` collection with a typed, ergonomic admin form: a preset selector, a compact collection×action grid, and `hasMany` selects for tool allow/deny — all sourced from the live Payload config + tool registry at runtime, with no per-collection field tree generated at build time. Drop the legacy `mcpAccessSettings` column and its lazy translator (already done in this branch). The `KeyScopes` runtime shape consumed by `registry.ts:assertScopeAllows` is preserved unchanged; new fields are normalised into it at auth time.

---

## Problem Frame

Today the `scopes` field is a `json` textarea — operators paste a `{ preset, collections, tools }` blob freehand. The shape lives only in the field's description string. Upstream's plugin solved the UX problem in the wrong direction: dynamically emitted one `collapsible > group > checkbox` triplet per collection per operation at config-build time. Twenty collections meant twenty collapsibles to click open and forty checkboxes to set, with no select-all, no presets, and a field tree whose shape changed whenever a collection was added.

Both extremes are bad. The right shape is typed Payload fields (so admin gets validation, search, GraphQL, REST for free) with **runtime-populated options** (so the field schema doesn't churn when collections change) and **bulk-selection ergonomics** baked in.

---

## Requirements

- R1. Operators can configure a key's scopes entirely through the Payload admin UI without typing JSON. The raw JSON field is removed from the edit view.
- R2. `preset` is a `select` field with options `read-only` / `editor` / `admin` / `custom`. Choosing a non-custom preset hides (or visually de-emphasises) the override fields.
- R3. Collection-level overrides surface as a `collectionScopes` array: each row has `collection` (select; options resolved from `payload.config.collections` minus the api-keys slug itself) and `actions` (multi-select with `read` / `create` / `update` / `delete`).
- R4. Tool allow/deny surface as two `select hasMany` fields (`toolAllow`, `toolDeny`) populated at runtime from the registered tool names.
- R5. The select-all / clear-all and search affordances Payload provides for `select hasMany` apply by default — no custom React component required for the v1 of this UI.
- R6. The runtime `KeyScopes` shape consumed by `registry.ts:assertScopeAllows` is unchanged. New fields are normalised into `{ preset, collections: Record<slug, Action[]>, tools: { allow, deny } }` inside the auth strategy when populating `_mcpKey.scopes`.
- R7. Existing v0.4.x rows that hold a populated `scopes` JSON object continue to authenticate. The auth strategy reads the new fields *and* the legacy `scopes` JSON column for one transitional release; if both are present, new fields win. Legacy column drops in the release after.
- R8. The `payload-mcp-api-keys` slug, `apiKey` / `apiKeyIndex` columns, and HMAC formula stay byte-identical — keys keep working zero-touch on upgrade.
- R9. Field options for `collectionScopes.collection` and `toolAllow` / `toolDeny` reflect the current Payload config + registered tools at request time. Adding a collection or tool surfaces it in the admin UI on next page load — no plugin restart, no schema regeneration.

---

## Scope Boundaries

- **No custom React field component.** The whole feature uses Payload's stock `select`, `array`, and `select hasMany` fields. A v2 could ship a single matrix component for collectionScopes (rows × checkbox columns) if the array UX feels heavy with 20+ collections.
- **No resource / prompt scopes.** v0.4 does not register MCP resources or prompts; nothing to scope.
- **No bulk-edit across keys.** Editing one key at a time. Mass-update via Payload's list view bulk-edit is out of scope.
- **No conditional admin-only field visibility based on the user's role.** Anyone with edit access on the api-keys collection can edit any field.

---

## Context & Research

### Relevant code

- `src/api-keys.ts` — collection factory; the `scopes` JSON field is the thing being replaced. Drop-in: keep all other fields (`name`, `description`, `user`, `keyPrefix`, `expiresAt`, `revokedAt`, `lastUsedAt`, `apiKey` from `useAPIKey: true`).
- `src/auth-strategy.ts` — `createBearerStrategy` populates `_mcpKey.scopes` on the request. This is where the new fields get composed back into `KeyScopes`.
- `src/registry.ts:assertScopeAllows` — pure consumer of `KeyScopes`. Untouched by this plan.
- `src/index.ts:contentToolkitPlugin` — has access to `config.collections` and to the toolkit's registered tools at plugin-setup time. The factory call site needs to thread "available collections" + "available tool names" into `createApiKeysCollection`.

### Upstream pattern (for reference, not adoption)

`@payloadcms/plugin-mcp` v3.82's `createApiKeysCollection` walks `mcpCollections` and emits one `collapsible` per slug at config-build time. We deliberately invert that: **field shape is static, options are dynamic**.

### Field-options strategy

Two viable patterns for the runtime-populated `options`:

- **(A) Frozen at plugin init.** `contentToolkitPlugin` reads `config.collections` after Payload finishes onInit, snapshots slugs/tool names, and passes them into `createApiKeysCollection`. Simple. Drift-prone if a collection is added in the same dev session — admin won't show it until restart.
- **(B) Resolved per-request via field `admin.components` or a custom `options` callback.** Payload supports function-form `options` on `select` only when called by the field-config builder, not lazily. So this requires a custom React component or virtual field hooks.

Pick **(A)** for v1. Restart-on-collection-add is acceptable (collections almost never change in production; in dev, the dev-server restart is already the trigger). Document the constraint. (B) becomes worth it only if we ship a custom matrix component anyway.

---

## Key Technical Decisions

- **Field shape over JSON shape.** Real Payload fields with constrained options. Operators get search, type-ahead, and validation; we get free REST/GraphQL exposure for any future tooling that wants to programmatically manage scopes.
- **Static schema, dynamic options.** Field definitions don't change when collections are added. Only the `options` array on the existing fields gets populated at plugin-init time. No regeneration of the api-keys collection's field tree.
- **Composition at auth time, not at field write.** New fields stay independent in storage. `auth-strategy.ts` builds the `KeyScopes` object on each authenticated request from whichever fields are populated. Cheap; keeps storage flat; no `beforeChange` hook syncing fields into a JSON blob.
- **Legacy `scopes` JSON column kept (read-only) for one release.** If a row has both new fields and legacy `scopes`, new fields win. If only `scopes` is set (existing v0.4 rows), it's used as-is. Drop the column in the release after this one.
- **Custom = "I want to override the preset."** The `preset` select includes `custom` as a sentinel meaning "use my collectionScopes / toolAllow / toolDeny instead." For `read-only` / `editor` / `admin`, override fields are ignored at auth time even if populated (and ideally hidden in admin via `admin.condition`).

---

## Open Questions

1. Should `collectionScopes` rows allow `actions: []` (zero actions = explicit denial of that collection)? Or should an empty actions array be treated as "all four actions"? **Tentative answer:** empty = deny. Matches the registry's existing semantics — listing a collection with no actions is a more useful primitive than "remove the row entirely."
2. When `preset = 'editor'` and `toolAllow = ['findDocument']` are both set, does `toolAllow` *narrow* the editor preset, or *replace* it? **Tentative answer:** narrow. `toolAllow` is always an additional whitelist filter on top of whatever the preset/collections grant. (This already matches `assertScopeAllows`.)
3. Should `toolDeny` support glob patterns (`safe*`) or just exact names? **Tentative answer:** exact only for v1. Glob is a v2 feature if the deny lists get unwieldy.

---

## Implementation Units

### U1. Drop legacy `mcpAccessSettings` field + translator

**Status:** Done in this branch (uncommitted).

**Files modified:**
- `src/api-keys.ts` — removed `mcpAccessSettings` field.
- `src/auth-strategy.ts` — removed `translateLegacyScopes` + lazy-migration block + `mcpAccessSettings` from `ApiKeyRow`.
- `src/__tests__/api-keys.test.ts` — removed legacy field assertions.
- `src/__tests__/auth-strategy.test.ts` — removed `translateLegacyScopes` test block + the lazy-translation auth test.

**Verification:** `pnpm build` and `pnpm test` clean after the U1 changes (run before starting U2).

### U2. Thread runtime options into `createApiKeysCollection`

**Files:**
- Modify: `src/api-keys.ts` — extend `CreateApiKeysCollectionOptions` with `availableCollections: string[]` and `availableTools: string[]`. These are required.
- Modify: `src/index.ts` — at the call site of `createApiKeysCollection`, build both arrays. `availableCollections` = `config.collections.map(c => c.slug)` minus the api-keys slug itself. `availableTools` = the registered tool names from the toolkit's tool registry (already known at this point).

**Approach:** Keep the `userCollection` arg as today. Both new args are required so we never silently ship a UI with empty option lists.

**Tests:** `api-keys.test.ts` — assert that the collection accepts and uses both arrays. New test: passing `availableCollections: ['posts', 'pages']` produces a `collectionScopes.collection` field whose `options` are exactly those slugs.

### U3. Replace `scopes` JSON with typed fields

**Files:**
- Modify: `src/api-keys.ts` — remove the `scopes` field; add four new fields:
  - `preset` — `select`, options: `read-only`, `editor`, `admin`, `custom`. Default: `custom`. Required.
  - `collectionScopes` — `array`, fields: `collection` (`select`, options from `availableCollections`, required) + `actions` (`select hasMany`, options: `read`, `create`, `update`, `delete`, required, min 0). `admin.condition: ({ preset }) => preset === 'custom'`.
  - `toolAllow` — `select hasMany`, options from `availableTools`. `admin.condition: ({ preset }) => preset === 'custom'`. Empty = no narrowing (matches today's "absent" semantics).
  - `toolDeny` — `select hasMany`, options from `availableTools`. Always visible (operators may want to layer a deny on top of any preset).
- Keep the legacy `scopes` JSON field, but mark `admin.hidden: true`, `admin.readOnly: true`, with a description explaining it's retained for one release.

**Tests:** field shape assertions — preset is required, options are exactly the four values, collectionScopes uses the supplied slugs, toolAllow/toolDeny use the supplied tool names, conditions reference `preset`.

### U4. Compose new fields into `KeyScopes` at auth time

**Files:**
- Modify: `src/auth-strategy.ts` — extend `ApiKeyRow` with the new fields. Add a private `composeScopes(row): KeyScopes | null` helper:
  - If any new field is populated, build `KeyScopes` from new fields and ignore legacy `scopes`:
    - `preset` → top-level `preset` (drop `'custom'` — it means "no preset").
    - `collectionScopes` array → `collections: Record<slug, actions[]>`.
    - `toolAllow` → `tools.allow` (when non-empty).
    - `toolDeny` → `tools.deny` (when non-empty).
  - Else fall back to `row.scopes` JSON (legacy v0.4.x rows).
  - Else null (full access).
- Update `_mcpKey.scopes` population to use the helper.

**Tests:** `auth-strategy.test.ts` — three table-driven cases:
  - Row with only new fields → `KeyScopes` reflects them; legacy `scopes` ignored.
  - Row with only legacy `scopes` → unchanged behaviour.
  - Row with both → new fields win.

### U5. Wire collection + tool list into the plugin call site

**Files:**
- Modify: `src/index.ts` — at the point where `createApiKeysCollection` is invoked, pass `availableCollections` and `availableTools`. The tool registry is constructed earlier in `contentToolkitPlugin`; `availableCollections` is derived from the `config.collections` array as it stands when the api-keys collection is being added.
- Verify: a collection slug isn't passed in until it's actually present on the config, so the api-keys collection's options match what's bootable.

**Tests:** `index-integration.test.ts` — assert that with two test collections + the toolkit's standard tools, the resulting api-keys collection's `collectionScopes.collection.options` and `toolAllow.options` reflect those inputs.

### U6. Documentation

**Files:**
- Modify: `README.md` — replace the JSON-shape paste block in the API-keys section with a brief "configure scopes in the admin UI" walkthrough. Reference Custom preset for advanced overrides. Note that programmatic configuration is still possible by populating the same fields via Payload's REST/GraphQL.
- Modify: `CHANGELOG.md` — add an entry under Unreleased: "API-key scopes are now configured via typed admin fields (preset + collection×action grid + tool allow/deny). The raw `scopes` JSON column is retained read-only for one release for back-compat with v0.4.0 rows."

### U7. Drop the legacy `scopes` JSON column

**Status:** Deferred to the release *after* this one.

**Approach:** Once telemetry / git age confirms no production rows still rely on the legacy column, remove the field from `api-keys.ts`, drop the legacy branch in `composeScopes`, drop the related test case.

---

## System-Wide Impact

- **Storage:** four new columns on `payload-mcp-api-keys`. Drizzle auto-syncs in dev (`push: true`); production requires a generated migration before deploy.
- **Auth path:** one extra branch in the strategy (`composeScopes`) — no extra DB calls.
- **Registry:** zero changes. `assertScopeAllows` still consumes `KeyScopes`.
- **Public API:** `CreateApiKeysCollectionOptions` gains two required fields. Anyone constructing the collection directly (rare; the plugin entry point handles this) needs to pass them.
- **Admin UI:** the api-keys edit view changes shape — operators will see new fields and a hidden legacy `scopes` field instead of one editable JSON blob.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Operators have populated v0.4.0 rows' `scopes` JSON in production and we remove it too eagerly | Keep legacy column for one release. New fields win when both are set. Document the deprecation in CHANGELOG. |
| Adding a collection in dev doesn't reflect in the admin UI until restart | Documented in README; matches Payload's general field-options behaviour. Acceptable for v1. |
| `admin.condition` on the override fields hides them when `preset !== 'custom'` but old data lingers in storage | Auth-time composition only honours the override fields when `preset === 'custom'`. Stale data in hidden fields is silently ignored. Could add a `beforeChange` clear-on-preset-switch in v2 if it becomes confusing. |
| 50+ collections would make the `collectionScopes` array UX heavy | Acceptable for now (most projects have <15 collections). Custom matrix component is a v2 if it shows up as friction. |
| Drizzle column type change from `json` to `text` (select) requires migration | Confirmed: only adding *new* columns this release; legacy `scopes` JSON column stays in place. |

---

## Documentation / Operational Notes

- README: a one-paragraph "Configuring scopes" section showing the admin UI walkthrough (preset → custom → collectionScopes), with a note that the same shape is editable via REST/GraphQL.
- The `Custom` preset value isn't persisted as a `KeyScopes.preset`; it's a UI sentinel meaning "use the override fields." Document this contract in the field's `admin.description`.
- Migration: prod deploys must run `pnpm payload migrate:create` to capture the new columns. Local dev relies on `push: true` per project convention.

---

## Sources & References

- Existing plan: `docs/plans/2026-05-04-001-feat-standalone-mcp-plugin-v04-plan.md` (the v0.4 standalone plan this builds on).
- Upstream reference: `node_modules/@payloadcms/plugin-mcp/dist/collections/createApiKeysCollection.js` and `dist/utils/createApiKeyFields.js` — for the dynamic-field-tree pattern we are *not* adopting.
- Registry contract: `src/registry.ts:assertScopeAllows` — pure consumer of `KeyScopes`; defines the shape this plan must compose.
