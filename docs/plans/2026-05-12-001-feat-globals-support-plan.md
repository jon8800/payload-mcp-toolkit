---
title: "feat: Globals support across MCP surface"
type: feat
status: completed
date: 2026-05-12
deepened: 2026-05-12
---

# feat: Globals support across MCP surface

## Summary

Add first-class support for Payload globals to the toolkit. Today the plugin reads `incomingConfig.collections` and ignores `incomingConfig.globals` entirely — there's one stub field (`exclude.globals` in `src/types.ts:55`) and no other code path. After this work, globals appear in introspection, in the `globals://schema` resource, in dedicated MCP tools (`findGlobal`, `updateGlobal`, optionally `patchGlobalLayout` / `publishGlobalDraft` / `listGlobalVersions` / `restoreGlobalVersion`), in the typed-scope `KeyScopes` model, and in the admin scopes matrix. Targeted for v0.6.0.

---

## Problem Frame

A "manage your site via AI chat" plugin that can't touch site-wide settings is an awkward product. On a typical Payload site, globals hold the things editors most want a chatbot to update through natural language: site name, tagline, footer links, social handles, header layout, contact info, banner text. They're singletons so they don't fit the collection-shaped tools (no `id`, no list, no `create` / `delete`), but they share most of the read/update path with collections, including optional drafts and versions.

The original v0.4 standalone-plugin brainstorm (`docs/brainstorms/standalone-plugin-2026-05-04.md:89`) flagged `findGlobal` as ported work — "wrapper around `payload.findGlobal()`. Handful of lines." It got dropped on the way to ship and was never reopened. This plan reopens it and goes further: write paths and scope plumbing too, because read-only globals access on its own would be confusing alongside full collection write access.

End-to-end testing of v0.5 confirmed the gap (this conversation, 2026-05-12): `updateDocument site-settings` returns `Error: Unknown collection "site-settings". Available: categories, authors, posts, pages` — the global is invisible to MCP.

---

## Requirements

- R1. Globals appear in the MCP surface: `tools/list` exposes global tools and `resources/list` exposes a `globals://schema` resource describing every (non-excluded) global's field shape.
- R2. `findGlobal { slug, draft? }` returns the current global document, honouring drafts on globals that have `versions.drafts` enabled, and stamping a preview URL when one is configured on the global's admin.
- R3. `updateGlobal { slug, data }` performs a partial merge (same semantics as `updateDocument`: merge-on-write, "Changed fields" in the response message).
- R4. When a global has a `blocks`-typed field, that field surfaces in the existing `blocks://nesting` map with `ownerType: "global"`, and `patchGlobalLayout { slug, layoutField, operation, blocks, index? }` works at any nesting depth — same operation grammar as `patchLayout`.
- R5. When a global has `versions.drafts` enabled, `publishGlobalDraft`, `listGlobalVersions`, and `restoreGlobalVersion` are exposed for it. When drafts are disabled, these tools are not registered for that slug.
- R6. Scopes apply to globals. `KeyScopes` gains a `globals: Record<slug, GlobalAction[]>` shape where `GlobalAction = 'read' | 'update'` (no `create`, no `delete` — globals don't support those). **Preset semantics are intentionally asymmetric** between collections and globals: `read-only` → `['read']`, `editor` → `['read']` (read-only on globals — see Key Technical Decisions for rationale), `admin` → `['read','update']`. Custom preset with explicit `globalScopes` overrides the preset.
- R7. The typed-scope admin UI surfaces globals alongside collections — a second matrix table (or a second tab inside the existing matrix) where rows are global slugs and columns are `read` / `update`. Pre-populated with the same select-all / clear-all affordances as the collections matrix.
- R8. `tools.allow` / `tools.deny` (the per-tool overrides) accept global tool names exactly like they accept collection tool names. No special-casing required at the field level — the admin form's tool list is rebuilt at plugin-init time from the registered tool names regardless of source.
- R9. `exclude.globals` (already declared in `ContentToolkitOptions`) is honoured: excluded global slugs do not appear in any tool description, any resource, the admin matrix, or the scope-evaluation surface.
- R10. Boot is zero-config for globals: a host config that has globals but no plugin options still sees them in MCP. No new required option.

---

## Scope Boundaries

### In scope
- Singleton CRUD: read + update for any global, partial-merge semantics.
- Draft workflow on globals that opt into `versions.drafts`.
- Block-nesting through globals (e.g., a `site-settings.heroLayout: { type: 'blocks' }` field becomes patchable via `patchGlobalLayout` to arbitrary depth, mirroring `patchLayout` exactly).
- Scope enforcement for globals: typed `scopes.globals`, presets honouring it, admin matrix UI surfacing it.
- Documentation, CHANGELOG, version bump to `0.6.0` (additive, non-breaking).

### Deferred to Follow-Up Work
- A `searchContent` cross-search across globals. Today `searchContent` walks collections only and pages results. Globals are singletons so the result shape is different (one doc per slug, no pagination), and most users searching content don't expect "Site Settings" to come back as a hit. Worth its own pass if a real use case appears.
- Schedule-publish for globals. The `schedulePublish` tool currently uses Payload's `_status` lifecycle on collection documents; the equivalent for globals would need separate validation and isn't urgent.
- A `resolveReference` extension for globals. Globals are referenced by slug, not ID; the existing fuzzy-name → id resolver doesn't have a useful analogue.
- `uploadMedia` does not change. Media is a collection, not a global.

### Out of scope
- Changing the existing collection tool surface. `findDocument`, `updateDocument`, `patchLayout`, etc. stay collection-only — no `target` arg, no overload. This was confirmed as the design choice with the user before planning (separate global tools).
- A "global preset" distinct from the collection preset. Presets continue to express role intent ("read-only", "editor", "admin") and apply uniformly to both collections and globals.

---

## Context & Research

### Relevant code (read these before implementing)

- `src/types.ts` — `ContentToolkitOptions`, `CollectionSchema`, `BlockNestingEdge`, the `exclude.globals` stub. Needs a `GlobalSchema` peer and a `globals: Record<slug, GlobalAction[]>` field on `KeyScopes` (currently lives in `auth-strategy.ts`).
- `src/introspection.ts` — `introspectCollection`, `introspectCollections`, `buildBlockNestingMap`, `hasCollectionDrafts`. Add `introspectGlobal`, `introspectGlobals`, `hasGlobalDrafts`, and extend the block-nesting walk to include globals as owners (`ownerType: 'global'`).
- `src/index.ts` lines 64–172 — the plugin's wire-up. Need to (a) read `incomingConfig.globals`, (b) introspect them, (c) walk their fields for block-nesting, (d) register the new global tools, (e) thread `availableGlobals` to `createApiKeysCollection`. Globals do not pass through the `auth.strategies` patch — they don't have auth collections.
- `src/registry.ts` — `TOOL_TO_ACTION`, `PRESET_ACTIONS`, `assertScopeAllows`. Needs a parallel `TOOL_TO_GLOBAL_ACTION` map, `PRESET_GLOBAL_ACTIONS`, and a global-routing branch in `assertScopeAllows` (selected by tool name → which it already has to disambiguate scope keys today).
- `src/resources.ts` — `generateResources`. Add `globals://schema`. Update `blocks://nesting` to include global-owned edges (no separate resource needed — the map is the same shape, just with `ownerType: 'global'`).
- `src/tools/*` — every existing tool. Use `find-document.ts` and `update-document.ts` as the template for the new global tools; use `patch-layout.ts` for `patchGlobalLayout`. The factory signature pattern (a `create*Tool` function returning a `ToolFactoryOutput`) stays identical.
- `src/auth-strategy.ts` — `composeScopes` and the `ApiKeyRow` type. Add a `globalScopes` field to the row and a `globals` key to the composed `KeyScopes`.
- `src/api-keys.ts` — `createApiKeysCollection`, the `collectionScopes` field, the matrix component wiring. Add `availableGlobals: string[]` to options, add a `globalScopes` array field with the same `array` shape but a `read` / `update`-only action set, point its admin component at a globals-aware matrix.
- `src/components/CollectionScopesMatrix.tsx` — the React matrix. Either extend it to accept `availableGlobals` and render a second table beneath the collections table, or split it into a generic `ScopesMatrix` with two instances. The renderer is already prop-driven, so this is mostly threading two more arrays.
- `dev/payload.config.ts` + `dev/globals/SiteSettings.ts` — exists, will be the smoke-test target.

### Brainstorm reference

- `docs/brainstorms/standalone-plugin-2026-05-04.md:89` — original "ship globals find" intent. The current plan honours that and extends to write paths because read-only globals next to read/write collections is asymmetric and confusing for users.

### Payload API surface (from `node_modules/payload/dist/index.d.ts`)

Local-API methods consumed by the new tools:
- `payload.findGlobal({ slug, draft?, depth? })`
- `payload.updateGlobal({ slug, data, draft? })`
- `payload.findGlobalVersions({ slug, where?, limit? })` — for `listGlobalVersions`
- `payload.restoreGlobalVersion({ slug, id })` — for `restoreGlobalVersion`

Drafts on globals are configured the same way as on collections (`versions: { drafts: true }`), so `hasGlobalDrafts` is a one-line analogue of `hasCollectionDrafts`.

---

## Key Technical Decisions

- **Separate tool names, not overloads.** `findGlobal` / `updateGlobal` / `patchGlobalLayout` / `publishGlobalDraft` / `listGlobalVersions` / `restoreGlobalVersion` are distinct from their collection counterparts. Confirmed with user. Rationale: globals lack `id`, `where`, `limit`, `create`, `delete` — overloading `findDocument` with a `target` arg would make every collection-only parameter optional-via-conditional and force every tool to branch internally. Distinct tools keep each schema tight, surface the singleton model honestly in `tools/list` descriptions, and let scope checks key off the tool name without an extra arg lookup.

- **`scopes.globals` keyed by slug, mirroring `scopes.collections`.** A separate record on `KeyScopes`. Compact actions list (`'read' | 'update'`). Composition rules at auth time follow the same pattern `composeScopes` uses today for collections.

- **`assertScopeAllows` gets a `resourceKind` parameter — not a deferred refactor.** Rename the third arg from `collection` to `resource` and add a fourth arg `resourceKind: 'collection' | 'global' | 'account'`. The four templated reason-strings (`Action "X" on collection "Y"…`, `Action "X" on global "Y"…`, etc.) interpolate the kind, so MCP error responses and the audit log report the correct resource type. Doing this in U6 itself — not as a follow-up — keeps the templating type-correct from day one and is a precondition for the audit-log field rename below. (Originally I planned tool-name-driven implicit routing with the arg still called `collection`. The architecture review flagged this as a real audit/correctness hazard: every denial message would say `Collection "siteSettings"…` for global denials, and the audit log's `collectionArg` field would misreport global operations.)

- **Tool→scope routing uses three explicit sets with a boot-time invariant.** Three disjoint sets at module scope: `TOOL_TO_ACTION` (collections), `TOOL_TO_GLOBAL_ACTION` (globals), and `ACCOUNT_LEVEL_TOOLS: Set<string>` (`searchContent`, `uploadMedia`, `resolveReference` — tools that act across all readable resources). A plugin-init assertion verifies every registered tool name appears in **exactly one** of the three sets and fails boot with an actionable message if not. Any tool name that escapes all three sets is denied at request time with `Tool "X" has no registered scope mapping`. This converts the "forget to register a new tool" trap from a silent fail-open into a boot-time error. The disjointness assertion catches overlaps; the membership assertion catches omissions.

- **Audit log uses `targetSlug` + `targetKind`, not `collectionArg`.** The existing audit log emits `collectionArg: <slug>` for every tool call. Global tools use `args.slug`, not `args.collection`, so a literal port would log `collectionArg: undefined` for every global operation — invisible to SIEM rules and incident-response queries. Rename the field to `targetSlug` (populated from `args.collection ?? args.slug`) and add a peer `targetKind: 'collection' | 'global' | undefined` populated from the routing lookup. Update existing collection-tool log sites in the same pass so the shape is consistent. CHANGELOG calls this out as an audit-log shape change (additive `targetSlug` / `targetKind`, removed `collectionArg`); operators with log-search rules need to update.

- **Empty-overrides deny-all sentinel extends across both resource axes.** The v0.5 sentinel (commit `b1043c4`) fail-closes a `preset: 'custom'` key with empty `collectionScopes` AND empty `toolAllow` AND empty `toolDeny` by composing `{ collections: {}, tools: { allow: [] } }`. U9 widens the guard to also require empty `globalScopes` and updates the returned shape to `{ collections: {}, globals: {}, tools: { allow: [] } }`. Symmetric tightening, no behavioural change for existing Custom keys that have any collection or tool override.

- **`tools.allow` without an explicit resource scope is a deny.** Today, `tools: { allow: ['updateDocument'] }` with no `collections` map and no preset would allow `updateDocument` on every collection — a latent issue collections already have. Globals raise the blast-radius ceiling enough that the fix lands now and applies symmetrically: when a tool resolves via `TOOL_TO_ACTION` or `TOOL_TO_GLOBAL_ACTION` and the corresponding `scopes.collections` / `scopes.globals` map is undefined and `scopes.preset` is undefined, deny the call.

- **`editor` preset is asymmetric on globals: read-only.** Collections under `editor` get `['read', 'create', 'update']`. Globals under `editor` get `['read']` only. Rationale: globals are singletons that broadcast site-wide on a single write (site name, footer links, social handles); a typo on one global rewrites every page that consumes it, with no per-document containment to fall back on. An LLM acting on an editor-tier key hallucinating "fix the site title" has a one-shot path to vandalism on every page. `admin` keys (and Custom keys with explicit `globalScopes`) retain write access. Documented prominently in README and CHANGELOG so the asymmetry isn't surprising. (Architecture review counter-argued for symmetry; security review's blast-radius case won the call.)

- **Excluded globals are filtered at tool-registration time, not at compose time.** Mirror the existing collection mechanism (`src/index.ts:96-106`): `options.exclude.globals` strips slugs from `exposedGlobalSchemas`, which feeds each tool's Zod `slug` enum. Calls with an excluded slug are bounced at the schema boundary before `assertScopeAllows` runs. `composeScopes` stays exclusion-unaware. This deliberately mirrors the existing collection behaviour (confirmed by repo research) rather than introducing compose-time hygiene that the rest of the codebase doesn't have.

- **Block-nesting map is unified.** One `BlockNestingMap` covers collection-owned and global-owned blocks fields. `BlockNestingEdge.ownerType` already exists as `'collection' | 'block'`; widen the union to include `'global'`. The `patchGlobalLayout` validator and the `patchLayout` validator share the same map lookup with the same key shape (`<owner>.<dottedFieldPath>`). A unit-level invariant test guarantees no `(owner, fieldPath)` pair appears twice with different `ownerType` values.

- **Draft-bearing global tools register conditionally.** Same gating as collection draft tools — if no global has drafts enabled, `publishGlobalDraft` / `listGlobalVersions` / `restoreGlobalVersion` are not added to `tools/list`. Keeps the surface small for sites that don't use global drafts.

- **Admin matrix: two stacked tables.** Inside the same form section. Collections matrix on top, globals matrix below, divided by a sub-heading. Avoids a tab UI for what is conceptually the same scope set. Both render only when `preset === 'custom'`. (Alternative considered: a `kind` column on a unified table. Rejected because the action columns differ — globals have no `create` / `delete`, so a single table would either show those columns greyed-out for globals (visual noise) or render variable-column rows (accessibility issue).)

- **`globalScopes` field is `type: 'json'`, mirroring `collectionScopes` exactly.** Not a Payload `array` field. The existing `collectionScopes` at `src/api-keys.ts:96` is `type: 'json'` with a custom matrix renderer fed by `clientProps` — a single JSONB column, not a join table. `globalScopes` mirrors that shape: one additive column on `payload-mcp-api-keys` with default `'[]'`. Keeps the migration trivially additive and matches the public "no breaking change" framing for storage. (Earlier draft of the plan said "array field" — that was incorrect; corrected during deepening.)

- **No new field on `payload-mcp-api-keys` beyond `globalScopes`.** The `preset`, `toolAllow`, `toolDeny` fields already apply globally and don't need a globals-specific peer. Only the per-resource override matrix needs a globals counterpart.

- **`availableGlobals` is an *optional* arg to `createApiKeysCollection` with `[]` default.** Originally planned as required to mirror `availableCollections`; downgraded to optional during deepening so the v0.6.0 release stays non-breaking for direct callers of the factory. Sites with no globals (the common case for the existing user base) work unchanged.

- **Tool descriptions list globals.** `findGlobal`'s description enumerates the available slugs (just like `findDocument` lists collections today), so the LLM has a one-shot view of what's reachable without consulting a resource.

---

## Open Questions

1. **Should `updateGlobal` always go through the draft path on a draft-enabled global?** Collections have `draftBehavior: 'always-draft' | 'always-publish'`. The same flag would make sense for globals. **Tentative answer:** yes, mirror the collection rule — `versions.drafts` on a global implies `draftBehavior: 'always-draft'` by default, with an `options.draftBehavior` override that accepts both collection and global slugs in the same record. Confirm during U8 when wiring the option.
2. **`patchGlobalLayout` index resolution when the global has multiple blocks fields.** A page has exactly one `layout` field by convention, but a global could plausibly have several (`header.blocks`, `footer.blocks`). The `layoutField` arg already disambiguates for collections; the same arg works for globals. No new question — flagging here so the implementer doesn't try to invent a "primary layout field" heuristic.

### Resolved during planning

- **Excluded globals + scope storage.** Resolved via repo research during deepening. Current collection behaviour: `options.exclude.collections` is consulted **only at tool-registration time** (`src/index.ts:96-106`) — excluded slugs are stripped from `exposedSchemas`, which feeds each tool's Zod `collection` enum. `composeScopes` and `assertScopeAllows` have zero awareness of exclusions. An LLM passing an excluded slug is bounced at the Zod input boundary before any scope check runs. **Decision:** mirror that mechanism for globals. U8 filters excluded slugs out of `exposedGlobalSchemas` parallel to the existing collection pattern; U9 (`composeScopes`) stays exclusion-unaware. No compose-time warn-log — the schema-level rejection is the existing user contract. If a future hardening pass adds compose-time hygiene, apply it symmetrically to both axes and re-evaluate the deny-all sentinel against the post-exclusion shape (deferred to a separate plan).

---

## Implementation Units

### U1. Types and global introspection

**Goal.** Stand up the data shapes and pure functions that everything downstream depends on.

**Requirements.** R1, R4, R6.

**Dependencies.** None.

**Files.**
- Modify: `src/types.ts` — add `GlobalSchema { slug, fields, hasDrafts, hasLivePreview }`, `GlobalAction = 'read' | 'update'`, widen `BlockNestingEdge['ownerType']` to `'collection' | 'block' | 'global'`. Move `KeyScopes` into types (currently in `auth-strategy.ts`) so the shape is canonical, and add `globals?: Record<string, GlobalAction[]>`.
- Modify: `src/introspection.ts` — add `hasGlobalDrafts(global)`, `introspectGlobal(global)`, `introspectGlobals(globals)`. Extend `buildBlockNestingMap` to accept a `globals` arg and walk each global's fields with `ownerType: 'global'`. Existing collection-only tests must still pass — globals arg defaults to `[]`.
- Modify: `src/auth-strategy.ts` — import `KeyScopes` from `types.ts`. No behaviour change yet.
- Modify: `src/__tests__/introspection.test.ts` (or create if absent) — coverage below.

**Approach.** Pure types + pure functions. Pattern lifted exactly from `introspectCollection` / `introspectCollections`. `buildBlockNestingMap` already takes `(collections, blocks)`; extend to `(collections, globals, blocks)` and update the one call site in `index.ts`.

**Patterns to follow.** `src/introspection.ts:14-49` (collection introspection); `src/introspection.ts:86+` (existing block-nesting walk).

**Test scenarios.**
- `hasGlobalDrafts` returns `true` for `{ versions: { drafts: true } }`, `false` for `{ versions: { drafts: false } }`, `false` for `undefined`, `false` for `{ versions: { maxPerDoc: 10 } }` (no drafts key).
- `introspectGlobal` of a simple text-field global returns `{ slug, fields: [...], hasDrafts: false, hasLivePreview: false }` with the field shape matching `extractFields` output.
- `introspectGlobals([])` returns an empty `Map`.
- `buildBlockNestingMap` with a global that has a top-level `layout: { type: 'blocks', blocks: [...] }` field emits an edge `{ owner: <slug>, ownerType: 'global', fieldPath: 'layout', acceptedBlockSlugs: [...] }`.
- `buildBlockNestingMap` with a global that has a nested `header: { type: 'group', fields: [{ name: 'links', type: 'blocks', blocks: [...] }] }` emits an edge with `fieldPath: 'header.links'`.
- `buildBlockNestingMap` with no globals (existing call shape) produces the same edges it produces today (regression guard).
- **Invariant: no `(owner, fieldPath)` pair appears twice with different `ownerType` values** in the emitted map (guards against a global and a collection sharing a slug + path, which would corrupt the validator lookup).

**Verification.** All new tests green; `pnpm tsc --noEmit` clean.

---

### U2. Globals resource + extended block-nesting resource

**Goal.** Expose globals to MCP clients via the resources surface so an AI can introspect what's available before reaching for a tool.

**Requirements.** R1, R4, R9.

**Dependencies.** U1.

**Files.**
- Modify: `src/resources.ts` — add a `globals://schema` resource. Update the `blocks://nesting` resource's data source to include global-owned edges (the resource body shape is unchanged; just the map it reads now contains globals).
- Modify: `src/__tests__/resources.test.ts` — coverage below.

**Approach.** `generateResources` currently takes `(collectionSchemas, blockCatalog, blockNesting, relationships)`. Add `globalSchemas: Map<string, GlobalSchema>` and emit a fourth resource. The `globals://schema` resource is shaped like `collections://schema` — a JSON array of `{ slug, fields, hasDrafts, hasLivePreview }`.

**Patterns to follow.** Existing `collections://schema` resource generator in `src/resources.ts`.

**Test scenarios.**
- `globals://schema` is present in `resources/list` when any global is registered.
- `globals://schema` is **not** present when zero non-excluded globals exist (matches how the plugin omits empty surfaces today; verify by inspecting current behaviour for collections — if absence-emits-empty-array is the convention, follow that instead).
- `globals://schema` body contains exactly the non-excluded global slugs.
- `blocks://nesting` body includes a `{ ownerType: 'global', owner: <slug>, fieldPath: <path> }` edge for a global with a blocks field. Existing collection-owned edges are unchanged.

**Verification.** Hit `resources/read` for both URIs in the dev harness and confirm shape matches snapshot.

---

### U3. `findGlobal` and `updateGlobal` tools

**Goal.** Read and partial-write any global through MCP.

**Requirements.** R2, R3, R6, R8.

**Dependencies.** U1.

**Files.**
- Create: `src/tools/find-global.ts` — factory `createFindGlobalTool(globalSchemas, draftGlobals, globalsBySlug, previewSiteUrl, previewDisabled)`.
- Create: `src/tools/update-global.ts` — factory `createUpdateGlobalTool(globalSchemas, draftGlobals)`.
- Create: `src/__tests__/find-global.test.ts`, `src/__tests__/update-global.test.ts`.

**Approach.** Each tool exports a `createFooTool(...)` factory returning a `ToolFactoryOutput` — same shape as `createFindDocumentTool` / `createUpdateDocumentTool`. Tool descriptions enumerate the available global slugs. Schemas use `z.enum(slugs)` for `slug`. `findGlobal` calls `payload.findGlobal({ slug, draft, depth: 1 })` and (when the global has drafts and live-preview admin config) stamps a preview URL. `updateGlobal` accepts a JSON-string `data` arg (same prose-input shape as `updateDocument` to keep the LLM input contract uniform), parses it, calls `payload.updateGlobal({ slug, data, draft })`, and returns a "Changed fields: …" message.

**Patterns to follow.** `src/tools/find-document.ts` (slug enum description, draft handling, preview stamping); `src/tools/update-document.ts` (partial-merge messaging, changed-fields response).

**Test scenarios.**
- `findGlobal { slug }` returns the published global; when the global is draft-enabled and `draft: true` is set, returns the draft view.
- `findGlobal` stamps a preview URL when the global has `admin.preview` or `admin.livePreview` configured, and **does not** stamp one when neither is configured. Skip preview stamping when `previewDisabled` is true (regression check matching collection behaviour).
- `updateGlobal { slug, data: '{"siteName":"X"}' }` performs a partial merge — other fields untouched. Response message lists `siteName` as the changed field.
- `updateGlobal` with malformed JSON returns a `data must be valid JSON` error mirroring `updateDocument`'s message.
- `findGlobal` with an unknown slug returns `Unknown global "X". Available: <list>`. Same shape as the collection error.
- Schema-validation: `tools/list` shows `findGlobal` and `updateGlobal` with a `slug` enum constrained to the supplied slug list.

**Verification.** Live-call against `dev/globals/SiteSettings.ts` — read, update one field, read back, confirm partial merge.

---

### U4. `patchGlobalLayout` tool

**Goal.** Surgical block-array edits on any blocks-typed field inside a global, at any nesting depth.

**Requirements.** R4, R6.

**Dependencies.** U1, U3.

**Files.**
- Create: `src/tools/patch-global-layout.ts` — factory `createPatchGlobalLayoutTool(blockCatalog, blockNesting, draftGlobals)`. Conditional on at least one global having a blocks-typed field anywhere in its tree — if none, the factory returns `null` and the plugin entry doesn't register it.
- Create: `src/__tests__/patch-global-layout.test.ts`.

**Approach.** Same operation grammar as `patchLayout` (`append` / `prepend` / `insertAt` / `replaceAt` / `full`, with `index` and `blocks`). The validator key is `<globalSlug>.<layoutField>` against the unified `BlockNestingMap` from U1. Same `validateBlockList` recursion. Calls `payload.findGlobal` → mutate → `payload.updateGlobal`.

**Patterns to follow.** `src/tools/patch-layout.ts` end-to-end. The conditional factory pattern matches `src/tools/schedule-publish.ts` (returns the tool only if any draftable collection exists).

**Test scenarios.**
- `patchGlobalLayout { slug, layoutField: 'footer', operation: 'append', blocks: [...] }` appends blocks to a global's existing layout array and persists.
- `replaceAt index: 0` swaps the first block; remaining blocks intact.
- Schema rejection: a block whose slug is not in the nesting map's `acceptedBlockSlugs` for that path returns a `blockType "X" not allowed here` error with the allowed-list.
- Nested validation: a `container > sections > twoColumn > leftColumn > heading` patch passes; an `< invalid > inside leftColumn` fails with the precise breadcrumb path.
- Tool is not registered when no global has any blocks field. Tool is registered when at least one global does.

**Verification.** Add a blocks field to `dev/globals/SiteSettings.ts` (e.g., `footerSections`) and execute a deep patch via curl through `/api/mcp`.

---

### U5. Global versions / drafts tools

**Goal.** Match the collection draft workflow on globals that opt into versions.

**Requirements.** R5.

**Dependencies.** U1, U3.

**Files.**
- Create: `src/tools/publish-global-draft.ts` — `createPublishGlobalDraftTool(draftGlobals)`.
- Create: `src/tools/global-versions.ts` — exports `createListGlobalVersionsTool(draftGlobals)` and `createRestoreGlobalVersionTool(draftGlobals)`. Mirrors `src/tools/versions.ts`.
- Create: `src/__tests__/global-versions.test.ts`.

**Approach.** Each factory returns `null` if no global has drafts enabled (no tools registered for that surface). `publishGlobalDraft` does the canonical "read draft → write with `_status: 'published'`" dance, the same shape as `publishDraft`. `listGlobalVersions` wraps `payload.findGlobalVersions`. `restoreGlobalVersion` wraps `payload.restoreGlobalVersion`.

**Patterns to follow.** `src/tools/publish-draft.ts`, `src/tools/versions.ts`.

**Test scenarios.**
- `publishGlobalDraft { slug }` on a draft-enabled global with a pending draft promotes it to published; `findGlobal { slug }` then returns the published shape.
- `publishGlobalDraft` on a global without drafts is not registered (tool absent from `tools/list`).
- `listGlobalVersions { slug, limit: 5 }` returns version metadata array, newest-first.
- `restoreGlobalVersion { slug, versionId }` rolls the global back to that version; verified by `findGlobal` returning the prior data.

**Verification.** Toggle `versions: { drafts: true }` on `dev/globals/SiteSettings.ts`, run end-to-end via curl.

---

### U6. Registry scope evaluation for globals

**Goal.** Refactor `assertScopeAllows` to take an explicit `resourceKind`, honour `scopes.globals`, close the latent `tools.allow`-only fail-open path symmetrically across collections and globals, and harden the routing with explicit account-level tool registration plus a boot-time invariant.

**Requirements.** R6, R8.

**Dependencies.** U1, U3 (need tool names to wire the action maps).

**Files.**
- Modify: `src/registry.ts`:
  - Add `TOOL_TO_GLOBAL_ACTION: Record<string, GlobalAction>` map.
  - Add `PRESET_GLOBAL_ACTIONS: Record<ScopePreset, GlobalAction[]>` with the **asymmetric** mapping per R6 (`read-only → ['read']`, `editor → ['read']`, `admin → ['read','update']`).
  - Add `ACCOUNT_LEVEL_TOOLS: Set<string>` containing `searchContent`, `uploadMedia`, `resolveReference`. Any tool not in any of the three sets is treated as an unregistered tool and denied.
  - Rename `assertScopeAllows`'s third arg `collection` → `resource`. Add fourth arg `resourceKind: 'collection' | 'global' | 'account'`. The four templated reason-strings interpolate the kind (`Collection "X"…`, `Global "X"…`, `Action "X"…` for account-level).
  - Add the routing prelude: look the tool up in the three sets; derive `resourceKind`; check the corresponding scope map (`scopes.collections` for collection kind, `scopes.globals` for global kind, preset-only for account-level).
  - Close the `tools.allow`-only fail-open: when a tool resolves to collection or global and the corresponding scope map is undefined and `scopes.preset` is undefined, deny with `Tool "X" requires an explicit <kind> scope or preset on this API key`.
  - Add `assertScopeRegistryInvariant(toolNames: string[])`: throws if any tool name is missing from all three sets, or appears in more than one. Called once during plugin init from `src/index.ts`.
  - Rename the audit log field `collectionArg` → `targetSlug` and add peer `targetKind: 'collection' | 'global' | 'account' | undefined`. Populate `targetSlug` from `args.collection ?? args.slug`; populate `targetKind` from the routing lookup. Apply to all three log sites (`src/registry.ts:289-302, 311-323, 329-345`).
- Modify: `src/index.ts` — call `assertScopeRegistryInvariant(tools.map(t => t.name))` after building the `tools` array, before passing it to the initializer factory. Fail boot with an actionable error if it throws.
- Modify: `src/__tests__/registry.test.ts` — coverage below.

**Approach.** The third resource set (`ACCOUNT_LEVEL_TOOLS`) makes the existing implicit "no action = account-level" branch explicit. Account-level tools are gated by preset (`searchContent` requires `read` action implied by preset; `uploadMedia` requires `create`; etc.) but never carry a resource scope — that's the existing v0.5 behaviour, now made explicit.

The `resourceKind` parameter is a small but real public-API change to `assertScopeAllows`. Update every internal call site in the same commit.

**Patterns to follow.** Existing `assertScopeAllows` branch structure (`src/registry.ts:114-192`). Existing audit-logging shape (`src/registry.ts:194-345`).

**Test scenarios.**

*Happy paths*
- `findGlobal { slug }` with `scopes.preset === 'read-only'` is allowed.
- `findGlobal` with `scopes.preset === 'editor'` is allowed (editor reads globals).
- `updateGlobal` with `scopes.preset === 'admin'` is allowed.
- `updateGlobal` with `scopes.globals = { siteSettings: ['read', 'update'] }` (Custom override) is allowed.
- Existing v0.5 admin-preset key with `globalScopes: null` (column read as null on legacy row) → `updateGlobal siteSettings` is **allowed** because the preset wins when no overrides are set. (Most common upgrade case.)

*Editor-asymmetry enforcement*
- `updateGlobal` with `scopes.preset === 'editor'` is **denied** with reason `Action "update" on global "siteSettings" is not permitted by this API key's preset.` (Asymmetry from collections.)
- `updateDocument` with `scopes.preset === 'editor'` is allowed (collection editor still writes).

*Read-only and per-resource denies*
- `updateGlobal` with `scopes.preset === 'read-only'` is denied with the preset rejection message.
- `updateGlobal` with `scopes.globals = { siteSettings: ['read'] }` (Custom narrow) is denied with `Action "update" on global "siteSettings" is not permitted by this API key's scope.`
- `scopes.globals = { siteSettings: ['read','update'] }` with no `collections` scope and no preset: `findDocument pages` is **denied** with the global-only-key guard message.

*Fail-closed extensions (security findings F1 + F2)*
- Composed `KeyScopes = { collections: {}, globals: {}, tools: { allow: [] } }` (the post-empty-Custom sentinel from U9): every tool — `findDocument`, `updateDocument`, `findGlobal`, `updateGlobal`, `searchContent`, `uploadMedia` — is denied.
- `scopes = { tools: { allow: ['updateGlobal'] } }` with no preset and no `globals` map: `updateGlobal siteSettings` is **denied** with `Tool "updateGlobal" requires an explicit global scope or preset on this API key`. (Closes the latent fail-open.)
- Symmetric: `scopes = { tools: { allow: ['updateDocument'] } }` with no preset and no `collections` map: `updateDocument pages` is denied with the matching collection variant.

*Account-level tools*
- `searchContent` with `scopes.preset === 'read-only'` is allowed (account-level, read-implied).
- `uploadMedia` with `scopes.preset === 'read-only'` is denied (read-only does not permit create).
- A registered tool whose name is in **none** of the three sets is denied at request time with `Tool "X" has no registered scope mapping`. (Belt-and-braces against drift between dispatcher and routing.)

*Registry invariant (architecture F1 + F6)*
- `assertScopeRegistryInvariant(['findGlobal', 'updateGlobal', 'findDocument'])` passes given the production maps include all three.
- `assertScopeRegistryInvariant([...allRegisteredTools, 'unregisteredTool'])` throws with an actionable message naming the offending tool. Assert this is wired into plugin init so a missing-registration mistake fails boot.
- Disjointness: a tool name added to both `TOOL_TO_ACTION` and `TOOL_TO_GLOBAL_ACTION` fails the invariant with a disjointness message.

*Tool-level denies still take precedence*
- `tools.deny` containing `updateGlobal` denies it before any preset/globals check (parity with collection deny).

*Audit-log shape*
- A `findDocument pages` invocation logs `{ targetSlug: 'pages', targetKind: 'collection', ... }`.
- A `findGlobal siteSettings` invocation logs `{ targetSlug: 'siteSettings', targetKind: 'global', ... }`.
- A `searchContent` invocation logs `{ targetSlug: undefined, targetKind: 'account', ... }`.

**Verification.** All registry tests green. Manual log inspection in dev confirms `targetSlug` / `targetKind` populate correctly for at least one collection tool call and one global tool call. CHANGELOG note covers the audit-field rename so downstream log consumers can update queries.

---

### U7. API-keys field + matrix component for globals

**Goal.** Operators can pick globals × actions in the admin UI under the Custom preset.

**Requirements.** R7, R9.

**Dependencies.** U1, U6.

**Files.**
- Modify: `src/api-keys.ts`:
  - Add `availableGlobals?: string[]` **optional** option with `[]` default (downgraded from required during deepening to preserve the non-breaking guarantee for direct callers of `createApiKeysCollection`).
  - Add `globalScopes` field with `type: 'json'` — **mirroring `collectionScopes` exactly**, not a Payload `array`. One JSONB column, default `'[]'`. The matrix renderer reads and writes the column shape as `Array<{ global: string; actions: GlobalAction[] }>`.
  - Plug its admin component into the matrix via `clientProps` (same wiring as `collectionScopes`).
- Modify: `src/components/CollectionScopesMatrix.tsx` — accept new props `availableGlobals?: string[]`, render a second table below the collections table titled "Global scopes" with columns "Read" / "Update". Refactor shared row-rendering into a helper if duplication crosses ~15 lines; otherwise inline both tables.
- Modify: `src/__tests__/api-keys.test.ts` — coverage below.

**Approach.** Keep both matrices in one component for cohesion (they always render together when `preset === 'custom'`). Pass `availableCollections` and `availableGlobals` through the same `clientProps` mechanism the existing matrix uses (see `src/api-keys.ts:104`). The component branches on `availableGlobals?.length` — render the second table only when there are globals to scope.

**Patterns to follow.** Existing `collectionScopes` field in `src/api-keys.ts:94+` (the `type: 'json'` shape is the load-bearing precedent here); matrix component in `src/components/CollectionScopesMatrix.tsx`.

**Test scenarios.**
- `createApiKeysCollection({ availableGlobals: ['siteSettings'] })` produces a `globalScopes` field with `type: 'json'` (regression-guard the storage shape so the migration story stays "one additive JSONB column").
- `createApiKeysCollection({})` (no `availableGlobals` arg) succeeds and registers `globalScopes` with an empty options list — no factory throw. (Optional-arg regression.)
- The matrix component receives `availableCollections` and `availableGlobals` via `clientProps` and renders both tables when both arrays are non-empty.
- When `availableGlobals` is `[]`, the second table is not rendered (no empty-state UI flashing).
- The "Global scopes" table has exactly two action columns: `Read` and `Update` (no `Create` / `Delete`).
- Both tables are hidden (via `admin.condition`) when `preset !== 'custom'`.
- Visual smoke (manual): screenshot the Custom-preset edit view with both tables present.

**Verification.** Live in the dev admin UI — switch a key to Custom, confirm both matrices render and round-trip data via Save.

---

### U8. Plugin entry wires it all together

**Goal.** The plugin reads `incomingConfig.globals`, runs the new introspection/resource/tool factories, and threads `availableGlobals` to the API-keys collection.

**Requirements.** R1, R5, R9, R10.

**Dependencies.** U1–U7.

**Files.**
- Modify: `src/index.ts` — read `incomingConfig.globals`, run `introspectGlobals`, compute `draftGlobals: Set<string>` and an `excludedGlobals` set, build a `globalsBySlug` map, append the new tool factories to the `tools` array (the conditional ones returning `null` are filtered out as today), pass `availableGlobals` to `createApiKeysCollection`. Update `buildBlockNestingMap` call site to pass globals.
- Modify: `src/draft-workflow.ts` — add `computeDraftGlobals` peer to `computeDraftCollections`, accepting `options.draftBehavior` (which may now mention global slugs) and `options.exclude.globals`.

**Approach.** Mirror the collection plumbing line-for-line. Where collections produce `draftCollections` / `exposedSchemas` / `availableCollections`, globals produce `draftGlobals` / `exposedGlobalSchemas` / `availableGlobals`. The `tools` array gains roughly six entries (4–6 depending on conditional registrations).

**Exclusion handling.** `options.exclude.globals` is consulted **only here, at tool-registration time** — exactly parallel to the existing `options.exclude.collections` mechanism (`src/index.ts:96-106`). Excluded slugs are stripped from `exposedGlobalSchemas` before tool factories run, so they never appear in any tool's Zod `slug` enum, the `globals://schema` resource, the `blocks://nesting` resource, or the `availableGlobals` array passed to `createApiKeysCollection`. An LLM passing an excluded slug is bounced at Zod input validation before scope check runs. `composeScopes` and `assertScopeAllows` stay exclusion-unaware (see resolved Open Q3).

**Registry invariant wiring.** After building the `tools` array, call `assertScopeRegistryInvariant(tools.map(t => t.name))` from U6. If it throws, propagate the error so plugin boot fails with the actionable message.

**Patterns to follow.** `src/index.ts:72-172` end-to-end is the template.

**Test scenarios.**
- A host config with one global (no drafts, no blocks fields) registers `findGlobal` + `updateGlobal` and nothing else global-related.
- A host config with one global (drafts enabled) additionally registers `publishGlobalDraft`, `listGlobalVersions`, `restoreGlobalVersion`.
- A host config with a global that has a blocks field additionally registers `patchGlobalLayout`.
- `options.exclude.globals: ['siteSettings']` removes that slug from all tool Zod enums, the `globals://schema` resource, the `blocks://nesting` resource (for that global's edges), and the `availableGlobals` passed to `createApiKeysCollection`.
- Zero-config: a host config with globals and no plugin options exposes them with sensible defaults (asymmetric preset semantics, no exclusions).
- A host config with **no** globals registers zero global tools and `createApiKeysCollection` receives `availableGlobals: []` (or omits the arg entirely, both supported).
- Boot fails fast with an actionable error if a registered tool name is absent from all three scope-routing sets (regression-guards the registry invariant from U6).

**Verification.** Boot the dev harness, hit `tools/list` and `resources/list`, confirm shape.

---

### U9. Auth strategy composition for globals

**Goal.** `_mcpKey.scopes` carries `globals` on every authenticated request.

**Requirements.** R6, R9.

**Dependencies.** U1, U7.

**Files.**
- Modify: `src/auth-strategy.ts`:
  - Extend `ApiKeyRow` with a `globalScopes?: Array<{ global: string; actions: GlobalAction[] }> | null` field (nullable to handle legacy v0.5 rows where the column is missing or null).
  - Extend `composeScopes` to convert `globalScopes` into `KeyScopes.globals`. Treat `null` / `undefined` / `[]` as "no override → preset applies" (NOT as the deny-all sentinel; the sentinel is Custom-only).
  - **Widen the empty-overrides deny-all sentinel** (commit `b1043c4`): the guard predicate must also require empty `globalScopes`. The returned shape must include `globals: {}` alongside `collections: {}` and `tools: { allow: [] }`. Without this widening, a Custom key with empty everything would fail-open on global tools — exact regression of the P1 fix in a new axis.
  - `composeScopes` stays **exclusion-unaware** (see resolved Open Q3). No compose-time exclusion filter, no warn-log. Excluded globals are filtered upstream in U8 at tool-registration time.
- Modify: `src/__tests__/auth-strategy.test.ts`.

**Approach.** Same shape as the existing `collectionScopes` → `KeyScopes.collections` conversion. The sentinel widening is the load-bearing change — without it, U6's per-resource fail-closed rules can't catch the "Custom with empty everything" case because `composeScopes` would never enter the sentinel branch.

**Patterns to follow.** `src/auth-strategy.ts:composeScopes` and the empty-overrides deny-all logic added in commit `b1043c4`. Search the function for the sentinel guard and the returned-shape literal — both need to widen in lockstep.

**Test scenarios.**

*Preset rollover (most common upgrade case — migration F4)*
- Row with `preset: 'admin'`, `globalScopes: null` (legacy v0.5 row) → `KeyScopes.globals` is `undefined`; downstream U6 lets the preset grant `update` on globals.
- Row with `preset: 'editor'`, `globalScopes: null` → `KeyScopes.globals` is `undefined`; downstream U6 denies `updateGlobal` per the asymmetric editor preset.
- Row with `preset: 'read-only'`, `globalScopes: []` → `KeyScopes.globals` is `undefined`; downstream U6 allows `findGlobal`, denies `updateGlobal`.

*Custom preset with overrides*
- Row with `preset: 'custom'` and `globalScopes: [{ global: 'siteSettings', actions: ['read'] }]` → `KeyScopes.globals = { siteSettings: ['read'] }`.
- Row with `preset: 'custom'`, `collectionScopes: [...]` populated, `globalScopes: []` → `KeyScopes.collections` populated, `KeyScopes.globals` undefined.

*Widened deny-all sentinel (security F1)*
- Row with `preset: 'custom'` and empty `collectionScopes` AND empty `globalScopes` AND empty `toolAllow` AND empty `toolDeny` → composed `KeyScopes = { collections: {}, globals: {}, tools: { allow: [] } }`. Every tool denied at the U6 layer.
- Row with `preset: 'custom'` and empty `collectionScopes` but `globalScopes: [{...}]` populated → sentinel does NOT fire (overrides exist on one axis); `KeyScopes.globals` populated, `KeyScopes.collections` empty whitelist (deny on collection tools, allow per globalScopes on global tools).
- Row with `preset: 'custom'`, only `toolAllow: ['findGlobal']` set, everything else empty → sentinel does NOT fire (tool override exists); but per security F2 enforced in U6, calls still need a resource scope or preset to land — `findGlobal` ends up denied at U6.

*Validation*
- `globalScopes` entries with unknown action values are filtered out (parity with collection action validation).
- `globalScopes` entries referencing slugs not in the live config still compose into `KeyScopes.globals` — they're harmless because Zod will reject the call upstream (exclusion-unaware design, parallel to collections).

**Verification.** Unit tests + a manual curl using a Custom key with `globalScopes` set, confirming `updateGlobal` is allowed/denied per the matrix. Re-confirm the "empty Custom" key denies every tool end-to-end.

---

### U10. Documentation and release

**Goal.** Document the new surface, bump version, update CHANGELOG with the asymmetries and migration steps that didn't exist in v0.5.

**Requirements.** R1, R10.

**Dependencies.** U1–U9.

**Files.**
- Modify: `README.md`:
  - Add a "Globals" section parallel to the collections walk-through; document the new tools and the matrix UI.
  - Update the API-key configuration section to mention globals × actions.
  - **Call out the editor-preset asymmetry explicitly**: a sub-section "Why `editor` is read-only on globals" explaining the blast-radius reasoning, with the workaround (use `admin` preset or a Custom key with explicit `globalScopes`) right next to it. This is the single most likely upgrade surprise; document it where operators will see it.
  - Add an "Upgrade from 0.5" sub-section that lists: (a) the `editor` preset behaviour change on globals; (b) the audit-log field rename (`collectionArg` → `targetSlug` + `targetKind`); (c) the production migration step (see CHANGELOG bullet below).
- Modify: `CHANGELOG.md` — add an `[0.6.0]` entry with these grouped sections:
  - **Added.** New tools (enumerate); `KeyScopes.globals` shape; admin matrix second table.
  - **Changed (breaking for operators on log queries).** Audit log field rename: `collectionArg` is replaced by `targetSlug` (string) + `targetKind` (`'collection' | 'global' | 'account' | undefined`). Update log-search rules.
  - **Changed (behaviour).** `editor` preset is now read-only on globals; previously globals weren't accessible at all so this is a default for the new surface, not a regression of a prior behaviour. Document the rationale.
  - **Changed (security hardening, symmetric to collections).** `tools.allow` without a corresponding `scopes.collections` map or `scopes.preset` now denies collection tool calls (was previously a latent fail-open); same rule applies to globals. Operators relying on `tools.allow`-only Custom keys must add a `collections` map or a preset.
  - **Upgrade notes.** Production deploys must run `pnpm payload migrate:create` after upgrading to capture the new `globalScopes` JSONB column on `payload-mcp-api-keys`. The plugin does not ship migration files because the host project owns its own migrations directory (matches v0.5 convention). Local dev with `push: true` auto-syncs the column on next `pnpm dev`.
- Modify: `package.json` — bump `version` to `0.6.0`.

**Approach.** Same documentation shape as the v0.5 typed-scope release, with two new emphases: the editor-preset asymmetry (most surprising change) and the audit-log shape change (silent breakage if undocumented).

**Test expectation:** none — pure documentation and version bump.

**Verification.** Manual review of README + CHANGELOG. Cross-check the "Upgrade from 0.5" section names every behaviour change introduced by U6/U9/U10 above. Confirm `pnpm payload migrate:create` against a v0.5-shaped DB locally produces a migration whose only change is the additive `globalScopes` JSONB column (no surprise alterations).

---

## System-Wide Impact

- **Storage.** One new **JSONB column** on `payload-mcp-api-keys` (`globalScopes`, `type: 'json'`, default `'[]'`). Mirrors `collectionScopes` exactly — not a Payload `array` field (which would generate a join table). Drizzle auto-syncs in dev (`push: true`); production needs a generated migration before deploy (see U10).
- **Auth path.** Two changes in `composeScopes`: a widened deny-all sentinel guard (now requires `globalScopes` empty too), and a new branch that maps `row.globalScopes` to `KeyScopes.globals`. Same per-request DB cost (no extra calls).
- **Scope evaluation.** `assertScopeAllows` signature changes: third arg renamed `collection` → `resource`, new fourth arg `resourceKind`. Three explicit tool routing sets (`TOOL_TO_ACTION`, `TOOL_TO_GLOBAL_ACTION`, `ACCOUNT_LEVEL_TOOLS`) with a plugin-init invariant. The `tools.allow`-only fail-open closes symmetrically for collections and globals (the existing latent collection issue gets fixed in passing).
- **Tool surface.** Up to six new tools registered (`findGlobal`, `updateGlobal`, optionally `patchGlobalLayout`, `publishGlobalDraft`, `listGlobalVersions`, `restoreGlobalVersion`). Conditional registration keeps the surface small for sites that don't need every shape.
- **Resource surface.** One new resource (`globals://schema`). `blocks://nesting` body gains additional edges when globals contain blocks fields; existing consumers parsing the array shape are unaffected.
- **Admin UI.** API-key edit view gains a second matrix table under Custom preset (only rendered when `availableGlobals.length > 0`). Non-custom preset views unchanged.
- **Audit log shape.** `collectionArg` field is replaced by `targetSlug` + `targetKind`. Operators with log-search rules need to update; called out in CHANGELOG (U10).
- **Public API of plugin.** `CreateApiKeysCollectionOptions` gains an **optional** `availableGlobals?: string[]` with `[]` default. Direct callers of `createApiKeysCollection` continue to work unchanged.
- **Preset semantics.** `editor` preset is intentionally asymmetric between collections (`['read','create','update']`) and globals (`['read']`). Documented prominently in README + CHANGELOG.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Tool-name collision or omission across the three routing sets (`TOOL_TO_ACTION`, `TOOL_TO_GLOBAL_ACTION`, `ACCOUNT_LEVEL_TOOLS`) silently fails-open at request time | Plugin-init invariant in U6 throws on any tool name missing from all three sets or present in more than one. Boot fails fast with an actionable message. Unit-test coverage exercises both the disjointness and membership cases. |
| `editor` preset asymmetry surprises v0.5 admin-key operators after upgrade | Editor preset on globals defaults to read-only (security finding F5). README + CHANGELOG call out the asymmetry explicitly under "Upgrade from 0.5"; admin keys retain full global write access; Custom keys can override per-global. |
| `tools.allow`-only Custom key relied on implicit "no resource scope = allow" behaviour today and breaks under symmetric tightening | Behaviour change documented under CHANGELOG "Changed (security hardening, symmetric to collections)". Operators must add an explicit `collections` / `globals` map or a `preset`. Unlikely to affect production keys (the `tools.allow`-only shape isn't a documented configuration), but listed so operators can spot it during upgrade. |
| Plugin upgrade where the v0.6 code runs against a v0.5 DB schema (rolled-back deploy, fresh install before `push: true` runs) errors on every authenticated request because the missing `globalScopes` column makes the api-key SELECT fail | `composeScopes` reads `row.globalScopes ?? null` defensively (helps if the column exists empty; does NOT help if missing entirely). The only real fix is migration ordering: README "Upgrade from 0.5" requires `pnpm payload migrate:create` before tagging the host app deploy. Local dev with `push: true` self-heals on next `pnpm dev`. |
| Audit-log field rename (`collectionArg` → `targetSlug` + `targetKind`) silently breaks operator dashboards | CHANGELOG calls this out as a Changed (breaking for log queries) entry. Field rename is unconditional — there's no compatibility alias because the original field misreports for global operations and a half-deprecated field would muddy security audits. |
| Operators on v0.5 keys (existing rows) authenticate unchanged after upgrade — admin-preset keys keep full access; editor-preset keys lose nothing (couldn't access globals before) | Additive column with default `'[]'`. Existing `collectionScopes` and preset unchanged. Migration F4 regression test in U6 covers the admin-preset-with-null-globalScopes case explicitly. |
| Adding a global to the host config in dev doesn't reflect in admin matrix until restart | Same constraint as collections; documented in README. Matches existing v0.5 behaviour. |
| `updateGlobal` with drafts uses Payload's `_status` semantics differently than collection updates | Smoke-tested in U5 against the dev harness before release. Snapshot the result shape so the test fails loudly if Payload's behaviour shifts. |
| Block-nesting through deeply nested global field paths (e.g., `header.menu.items.blocks`) walked incorrectly | The existing walker already handles dotted paths for collections; U1 test scenarios cover the global analogue (`header.links`). Live verification in U4 with a `dev/globals/SiteSettings.ts` blocks field. |
| `(owner, fieldPath)` collision in the unified BlockNestingMap (a collection and a global sharing both slug and field path) corrupts the validator lookup | U1 invariant test asserts no `(owner, fieldPath)` pair appears with different `ownerType` values. Prevents accidental shared-keyspace bugs. |

---

## Sources & References

- Brainstorm: `docs/brainstorms/standalone-plugin-2026-05-04.md:89` — original "ship `findGlobal`" intent.
- Prior plan (architectural pattern source): `docs/plans/2026-05-09-001-feat-scope-admin-ui-plan.md` — the typed-scope admin UI shape that U7 mirrors.
- Codex P1 finding: commit `b1043c4` — empty-overrides deny-all sentinel that U9 extends to the globals dimension.
- Payload API contracts: `node_modules/payload/dist/index.d.ts` — `findGlobal`, `updateGlobal`, `findGlobalVersions`, `restoreGlobalVersion`.
- Conversation context (this session): live end-to-end test surfaced the gap; `updateDocument site-settings` returned `Error: Unknown collection "site-settings"`.
