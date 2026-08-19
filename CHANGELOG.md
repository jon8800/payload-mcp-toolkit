# Changelog

All notable changes are tracked here. The format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/).

## [0.8.0] - 2026-08-19

### Added
- **`customTools` option.** Host apps can register their own MCP tools next to
  the built-in ones:
  ```ts
  mcpToolkitPlugin({ customTools: [myTool] })
  ```
  Each entry is a `ToolFactoryOutput` — `{name, description, parameters,
  routing, handler}`. Custom tools go through the same per-request wrapper as
  the built-ins, so scope checks, the `req.context.source = 'mcp'` stamp, and
  the audit log all apply, and their names appear in the API-key scope
  dropdowns. The handler receives the live `PayloadRequest`, so a tool reads
  `req.payload` / `req.user` per call instead of closing over them at boot.
- **Public types and helpers for writing those tools:** `ToolFactoryOutput`,
  `PromptFactoryOutput`, `ResourceFactoryOutput`, `ToolRouting`, `ResourceKind`,
  `McpTextResponse`, plus the `textResponse` / `jsonResponse` envelope builders.
- **Boot-time name-collision check** (`assertNoToolNameConflict`). A custom tool
  that reuses a built-in name — or two custom tools sharing a name — throws with
  both names in the message. Registering a duplicate is last-wins inside the MCP
  SDK, which would otherwise make a built-in tool silently vanish from
  `tools/list`.

### Fixed
- **A resource-routed tool called without a target is now denied.**
  `checkResource` previously returned `allowed: true` when the call carried no
  `collection` / `slug`, deferring to schema validation — safe for the built-ins,
  because every collection- and global-routed built-in takes that argument as
  required. `customTools` broke the assumption: a host tool could declare
  `routing.kind: 'collection'`, take no collection argument, and read a
  hard-coded collection straight past the key's whitelist. Missing targets now
  fail closed with a message pointing at `routing.kind: 'account'`, which is the
  correct routing for a fixed or install-wide target. No built-in behaviour
  changes.
- **A malformed `toolAllow` is no longer read as "no restriction".** The
  `beforeValidate` hook nulls the value only when it is genuinely unset (null,
  undefined, or `[]`). A bare string or number now survives to Payload's
  validator, which rejects it, instead of being silently normalised into an
  unrestricted key.
- **A handler that reports failure in its result envelope is logged as a
  failure.** The audit log stamped `success: true` on any fulfilled handler
  promise, including one returning `{isError: true}` — the MCP spec's own way of
  letting a model self-correct. Those calls now log at `warn` with
  `success: false`.
- **A Custom-preset API key created through the Local API no longer denies every
  tool.** `payload.create()` omits `toolAllow` entirely; Payload reads the unset
  hasMany select back as `[]`, which `composeScopes` honours as deny-all on the
  tools axis. The `beforeValidate` hook already nulled an explicit `[]` when the
  key carried collection or global scopes — it now treats a missing value the
  same way, so a scripted key with resource scopes and no tool list is gated by
  its resource scopes alone, as the field description says. Keys created through
  the admin UI were unaffected (the form submits `[]`).

### Changed
- **`zod` peer range widened to `^3.25 || ^4`**, and the
  `@modelcontextprotocol/sdk` dependency floor raised from `^1.18.0` to
  `^1.23.0` to match. The two ranges have to move together: SDK 1.18 depends on
  zod `^3.23.8` and cannot handle zod 4 schemas, so the widened peer range would
  have been a false promise for any host whose lockfile held an older SDK. 1.23
  is the first release declaring `^3.25 || ^4.0`. The plugin source was already
  zod-4 clean (every `z.record` call uses the two-argument form). Verified end to
  end against a Payload 3.88 / Next 16.3 / zod 4.4 host: `initialize`,
  `tools/list`, and a `findDocument` call all succeed.
- **`ToolFactoryOutput` is the only new type export.** `PromptFactoryOutput` and
  `ResourceFactoryOutput` were dropped before release — there is no
  `customPrompts` / `customResources` option, so exporting them would have
  committed to a public shape with no extension point behind it.
- **`engines.pnpm` relaxed to `>=9`** so the repo's own scripts run under
  pnpm 11.

### Note
- 0.7.2 – 0.7.5 were publishing-pipeline releases and carry no changelog entry.
  Their only functional change is 0.7.5's `createDocument`, which now returns
  `_status` and uses `documentId` consistently.

## [0.7.1] - 2026-05-24

### Fixed
- **`publishDraft` / `publishGlobalDraft` no longer falsely report success when a
  publish attempt fails against a document that already has a published version
  from an earlier successful publish.** The previous recovery branch caught the
  Payload validator-after-version-row-commit throw and re-read the live doc with
  `draft: false`; if `_status === 'published'` was returned, the tool emitted a
  success-with-warning. That logic could not distinguish "this attempt landed
  despite the validator throw" from "a prior publish was successful and this
  attempt did nothing", so a real publish failure silently looked like success.
  Recovery now snapshots `updatedAt` before the update and only downgrades to a
  warning when the post-throw live read shows `_status === 'published'` AND a
  strictly newer `updatedAt`. Pre-snapshot or verify-read failures conservatively
  fall through to the original error path.
- **API-key field descriptions now match the v0.7.1 override semantics.** Under
  the Custom preset, an empty `toolAllow` is treated as deny-all ONLY when no
  collection or global scopes are set (the fresh-Custom sentinel); when
  resource scopes are populated, the empty `toolAllow` collapses to "no tool
  restriction" so the resource scopes alone gate access. The preset field also
  documents that switching away from Custom clears every override on save and
  re-entering Custom starts from a fresh deny-all baseline.
- **`composeScopes` docstring updated** to reflect that the per-axis explicit-
  empty=deny rule is Custom-only and that the on-write counterpart lives in the
  API-keys `beforeValidate` hook. Legacy non-Custom rows persisted before v0.7.1
  with populated stale override arrays continue to narrow on read until each
  row is manually re-saved.

### Added
- **Machine-parseable token in publish recovery responses.** Both
  `publishDraft` and `publishGlobalDraft` prefix the success-with-warning text
  with a stable token (`[publishDraft:published_with_warning]` /
  `[publishGlobalDraft:published_with_warning]`) so MCP clients can branch on
  the partial-success state without regex-matching prose.
- **Test coverage for the publish post-write recovery branch** (`__tests__/publish-draft.test.ts`),
  the Custom→Admin→Custom round-trip, the partial-form-submission
  beforeValidate path, and the `toolDeny` non-Custom asymmetry in
  `composeScopes`.

### Internal
- Extracted `snapshotPublishMarker` and `verifyPublishSucceededDespiteError`
  into `tools/_helpers.ts` so the two publish tools share one implementation.
- `publishGlobalDraft` recovery now passes `fallbackLocale: false` on the
  snapshot and verify reads when a locale is supplied, so the verify reflects
  the literal `_status` of the requested locale instead of inheriting a
  different locale's published state.
- `composeScopes` emits a one-time `mcp.auth.legacy_non_custom_override` warn
  when a non-Custom preset row carries populated override arrays (likely a
  pre-v0.7.1 row carried over from a prior Custom configuration). The
  narrowing still applies on read — re-save affected keys to clear the
  warning.
- Typed the `payload-mcp-api-keys` `beforeValidate` hook with
  `CollectionBeforeValidateHook` from Payload; consolidated the data /
  originalDoc field-read pattern in the hook body behind `readField` and
  `isNonEmptyArray` / `isEmptyArray` helpers; renamed `composeScopes`
  internals from `*ScopesActive` to `emit*Scopes` to match the existing
  `emitDeny` precedent.

## [0.7.0] - 2026-05-23

### Changed (breaking)
- **Renamed exported plugin factory `contentToolkitPlugin` → `mcpToolkitPlugin`**
  so the public symbol matches the package name (`payload-mcp-toolkit`).
  Update the import + `plugins[]` entry in `payload.config.ts`:
  ```ts
  - import { contentToolkitPlugin } from 'payload-mcp-toolkit'
  + import { mcpToolkitPlugin } from 'payload-mcp-toolkit'

  - plugins: [contentToolkitPlugin()],
  + plugins: [mcpToolkitPlugin()],
  ```
  No options, runtime behaviour, or scope semantics changed — pure rename.

## [0.6.2] - 2026-05-23

### Fixed
- **REST-minted keys no longer accidentally deny all tools.** Payload defaults
  `hasMany` select fields to `[]`, which Track A (`a0a8b9b`) treats as
  "deny-all on this axis." That was the intended semantic for explicit
  Custom-preset configurations but a UX trap for preset-mode keys created
  via the REST API without specifying `toolAllow` / `toolDeny`. A
  `beforeValidate` hook on the API-keys collection now coerces empty
  `toolAllow` / `toolDeny` to `null` when the key's preset is **not** Custom.
  Custom-preset keys retain the explicit-empty-equals-deny semantic intact.
- **Clearer rejection message for unknown or excluded global slugs.**
  Global-routed tools (`findGlobal`, `updateGlobal`, `patchGlobalLayout`,
  `publishGlobalDraft`, `listGlobalVersions`, `restoreGlobalVersion`) used
  a bare `z.enum` over the host's exposed global slugs, which surfaced
  Zod's default "Invalid enum value" message. The new `slugEnum` helper
  attaches an `errorMap` that names the valid set and clarifies that
  unknown or excluded slugs are rejected — easier to diagnose when a slug
  was hidden via `options.exclude.globals`.

## [0.6.1] - 2026-05-23

### Fixed
- **Account-tool scope bypass under preset + resource override.** Keys that
  combined a preset (e.g. `admin`) with an explicit
  `collectionScopes`/`globalScopes` whitelist were correctly narrowed on
  collection- and global-routed tools, but account-routed tools
  (`searchContent`, `resolveReference`, `uploadMedia`) ignored the
  whitelist and granted whatever the preset alone would have allowed —
  letting a key pinned to `posts:read` search every collection or upload
  media into any collection. `checkAccount` now denies account-routed
  tools whenever the key carries any explicit collection or global scope,
  since account-level tools span the whole site by design and cannot be
  narrowed to a slug at call time.
- **Excluded globals leaked into `blockNesting`.** `buildBlockNestingMap`
  ran against the unfiltered `globals` list before
  `options.exclude.globals` was applied, so an excluded global with a
  blocks field still surfaced in `patchGlobalLayout`'s slug enum and in
  the `blocks://nesting` resource body. The plugin entry now filters
  collections and globals by their exclusion sets before building the
  nesting map.
- **Dev import map missing `GlobalScopesMatrix`.** `dev/app/(payload)/admin/importMap.js`
  registered `CollectionScopesMatrix` only; opening the API Keys admin
  view in the dev app under the Custom preset failed to resolve
  `payload-mcp-toolkit/client#GlobalScopesMatrix`. The dev import map now
  includes the global matrix export.

### Added
- **Optional `locale` arg on every global tool.** `findGlobal`,
  `updateGlobal`, `patchGlobalLayout`, `publishGlobalDraft`,
  `listGlobalVersions`, and `restoreGlobalVersion` now accept an optional
  `locale` parameter that is forwarded to the underlying Payload Local API
  call — lets MCP clients scope reads and writes to a single locale on
  localized globals.
- **CAS guard on global mutations.** `patchGlobalLayout` and
  `restoreGlobalVersion` accept an optional `expectedUpdatedAt`. When set,
  the tool fetches the current global, compares `updatedAt`, and aborts
  with a "Conflict:" error if the value has changed since the caller's
  prior read. Protects against lost writes when concurrent edits race.

### Changed
- **Admin scope-matrix copy.** The "Collection scopes" and "Global scopes"
  matrix descriptions no longer claim the matrix is "only honoured when
  the preset is Custom" — the registry honours saved overrides on a key
  whenever they are populated, regardless of which preset is later
  selected. The fields remain editable only under the Custom preset; the
  copy now reflects the actual runtime semantics.

### Removed
- **`zodRefForDeps`** dead re-export of `z` from `src/registry.ts`. Was
  never referenced internally or externally.

## [0.6.0] - 2026-05-13

### Added
- **First-class globals support across the MCP surface.** Sites with Payload
  globals can now read and write them through the toolkit:
  - `findGlobal { slug, draft? }` — reads any global, stamps a preview URL on
    draft documents when the global's `admin.livePreview` / `admin.preview`
    is configured.
  - `updateGlobal { slug, data }` — partial-merge update with the same prose
    JSON contract as `updateDocument`; response message lists the changed
    field names.
  - `patchGlobalLayout { slug, layoutField, operation, blocks, index? }` —
    surgical block-array edits on any `blocks`-typed field inside a global,
    at any nesting depth. Mirrors `patchLayout`'s operation grammar.
    Conditionally registered (only when at least one global has a blocks
    field anywhere in its tree).
  - `publishGlobalDraft`, `listGlobalVersions`, `restoreGlobalVersion` —
    registered only for globals with `versions.drafts` enabled.
  - `globals://schema` resource — JSON schema of every non-excluded global.
  - `blocks://nesting` body now includes global-owned edges with
    `ownerType: "global"`; existing collection-owned edges are unchanged.
- **`KeyScopes.globals`** typed scope axis, keyed by global slug with the
  `'read' | 'update'` action vocabulary. Mirrors `KeyScopes.collections`.
- **Admin matrix UI gains a "Global scopes" table** beneath the existing
  "Collection scopes" table under the Custom preset. The new table only
  renders when at least one global is registered. Both matrices use a
  shared `ScopesTable` renderer.
- **`exclude.globals` honoured.** Excluded global slugs are filtered out of
  every tool's Zod `slug` enum, the `globals://schema` resource, the
  `blocks://nesting` edges for that global, and the `availableGlobals` array
  passed to the admin matrix.

### Changed
- **Audit log shape change.** The per-tool audit log field `collectionArg`
  is replaced by two fields:
  - `targetSlug` — populated from `args.collection ?? args.slug`, so global
    operations now appear in audit queries (previously they logged
    `collectionArg: undefined`).
  - `targetKind` — `'collection' | 'global' | 'account' | undefined`, derived
    from the registry's tool-routing lookup.

  Operators with SIEM rules or dashboards filtering on `collectionArg` must
  update their queries. The rename is unconditional — there is no
  compatibility alias because the original field misreports for global
  operations and a half-deprecated field would muddy security audits.
- **`editor` preset is intentionally read-only on globals.** Collections
  under `editor` continue to get `['read', 'create', 'update']`; globals
  under `editor` get `['read']` only. A typo on a global broadcasts
  site-wide on a single write (site name, footer links, social handles) with
  no per-document containment to fall back on, so editor-tier keys cannot
  reach `updateGlobal` / `patchGlobalLayout`. To write globals from a
  non-admin key, use the Custom preset with an explicit `globalScopes`
  entry. This is a behaviour decision for the new surface, not a regression
  of any prior behaviour — globals weren't reachable from any preset in
  v0.5.
- **`tools.allow` without an explicit resource scope is now a deny.**
  Previously, `tools: { allow: ['updateDocument'] }` with no `collections`
  map and no preset would allow `updateDocument` on every collection. The
  fix lands now and applies symmetrically to collections and globals: when a
  tool resolves to a collection or global kind and the corresponding scope
  map is undefined AND `scopes.preset` is undefined, the call is denied
  with `Tool "X" requires an explicit <kind> scope or preset on this API
  key`. Operators relying on the `tools.allow`-only shape (not a documented
  configuration) must add an explicit `collections` / `globals` map or a
  preset.
- **`collectionScopes` and `globalScopes` JSONB columns now store rows shaped
  `{slug, actions}`** (previously `{collection, actions}` / `{global, actions}`).
  composeScopes accepts both shapes for one release; v0.7 will drop the
  legacy fallback. The shape change unifies the two scope axes under one
  `ScopeRow` interface, dropping the `ScopesTable` `itemKey` prop.
- **`scopes.collectionArg` log field is gone** (covered above).
- **`BlockNestingEdge.ownerType` (exported TS type) widened** from
  `'collection' | 'block'` to `'collection' | 'block' | 'global'`. Downstream
  code consuming the `blocks://nesting` resource or the typed export via
  exhaustive `switch` / discriminated-union narrowing must add a `'global'`
  arm or a default branch. Runtime behaviour is unchanged for code that
  ignores the new ownerType — existing collection/block edges still emit
  with their original values.

### Migration
- Production deploys must run `pnpm payload migrate:create` after upgrading
  to capture the new `globalScopes` JSONB column on `payload-mcp-api-keys`.
  The plugin does not ship migrations because the host app owns its
  migrations directory (consistent with v0.5). Local dev with `push: true`
  auto-syncs the column on next `pnpm dev`.
- Existing v0.5 admin-preset keys keep full access after upgrade. The new
  `globalScopes` column reads as `null` on legacy rows; `composeScopes`
  treats null/undefined/empty as "no override → preset applies", so
  admin-preset keys retain `update` on globals.

## [0.5.0] - 2026-05-12

### Changed
- **API-key scopes are now configured via typed admin fields.** The freehand
  `scopes` JSON textarea is replaced by `preset` (Read-only / Editor / Admin /
  Custom), `collectionScopes` (per-collection action whitelist, custom only),
  `toolAllow` (tool whitelist, custom only), and `toolDeny` (deny-list, always
  applied). Collection and tool dropdowns are populated at plugin-init time
  from the host Payload config and the registered tool list. The runtime
  `KeyScopes` shape consumed by the dispatch path is unchanged — typed fields
  are composed into it at auth time.

### Fixed
- **Custom preset with no overrides now denies everything.** A regression
  introduced earlier in this cycle made freshly-created keys (which default
  to `preset: custom`) authenticate at full access until overrides were
  added — the inverse of the intended fail-closed default. `composeScopes`
  now emits an explicit deny-all shape (`{ collections: {}, tools: { allow:
  [] } }`) for empty-overrides custom keys; partial-override custom keys
  are unchanged. Caught by Codex review.

### Removed
- **Legacy `scopes` JSON column.** Dropped outright (no transitional release).
  Existing v0.4.0 rows authenticate but carry no scopes (= full access) until
  re-scoped via the admin UI.
- **Legacy `mcpAccessSettings` lazy migration.** The v0.3.x → v0.4
  on-first-lookup translator and the hidden `mcpAccessSettings` column are
  gone. v0.3.x rows authenticate but carry no scopes — re-scope them from
  the admin UI.

### Known limitations
- **Browser MCP clients are not yet supported end-to-end.** The
  `auth.allowedOrigins` option restricts which origins may call `/api/mcp`,
  but the endpoint does not yet emit CORS response headers or handle the
  `OPTIONS` preflight that browsers send before authenticated cross-origin
  POSTs. Server-to-server callers (backend scripts, Claude Desktop's local
  connector) are unaffected. Browser support will land in a follow-up
  release once there's a concrete client to validate against.

## [0.4.0] - 2026-05-05

### Added
- **Standalone plugin.** The toolkit now owns the `/api/mcp` endpoint, the
  `payload-mcp-api-keys` collection, and bearer authentication via Payload's
  native `auth.strategies` extension point. `@payloadcms/plugin-mcp` is no
  longer a dependency or peer dependency.
- **Scoped per-key authorization.** New `scopes` JSON field on API-key rows
  with three role presets (`read-only`, `editor`, `admin`), per-collection
  action overrides, and per-tool allow/deny lists. Tool-call dispatch
  enforces the resolved scopes and returns spec-compliant `isError: true`
  results on rejection (no JSON-RPC error codes, so the LLM can self-correct).
- **Lifecycle fields** on the API-keys collection: `name`, `description`,
  `expiresAt`, `revokedAt`, `lastUsedAt`, `keyPrefix`. `lastUsedAt` is
  written fire-and-forget; the request hot path is never blocked on the write.
- **`findDocument`** — polymorphic find tool keyed by `collection` arg.
  Mirrors `createDocument` / `updateDocument` shape. Decorates draft
  documents with preview URLs.
- **`deleteDocument`** — fast unsafe delete for surgical use; `safeDelete`
  remains the recommended default.
- **Plugin-conflict detection.** Boot fails fast with an actionable upgrade
  message if `@payloadcms/plugin-mcp` is also registered, or if another
  collection has taken the api-keys slug.
- **Origin / Host validation** on `/api/mcp` POST mitigates DNS-rebinding
  attacks against local Payload instances. CORS defaults to no-browsers
  (server-to-server only); explicit opt-in via `auth.allowedOrigins`.
- **Audit logging** on every tool call: structured `req.payload.logger`
  entry with `keyId`, `keyPrefix`, `tool`, `collectionArg`, `dataKeys`
  (top-level keys only — never values), `success`, `isError`, `durationMs`,
  `requestId`, `errorClass`. Long string args are summarised as
  `<truncated:N>` to keep logs bounded.

### Changed
- The bearer auth strategy reuses Payload's built-in `useAPIKey: true`
  columns and HMAC formula so existing v0.3.x API-key rows authenticate
  without re-issue.
- v0.3.x's dynamic `mcpAccessSettings` field tree is replaced by the new
  `scopes` JSON column. The first authenticated request from each existing
  key lazily translates its old per-collection / per-tool flags and persists
  the result. The legacy column is retained (hidden) for one release; it
  will be dropped in v0.5.
- `draft-workflow.ts` slimmed to `getDraftBehavior` + `computeDraftCollections`.
  The plugin no longer produces an upstream `mcpCollections` config object.

### Removed
- `@payloadcms/plugin-mcp` peer dependency.
- `generateMcpCollectionConfigs` / `createOverrideResponse` /
  `resolvePreviewUrl` from `draft-workflow.ts`. Preview decoration now lives
  in `tools/_helpers.ts` as `decorateDraftResponse` + `resolvePreviewUrl`,
  reusable across find/create/update tools.

### Migration
See [README → Upgrading from 0.3.x](./README.md#upgrading-from-03x).

## [0.3.4] - 2026-05-04

### Added
- `createDocument` tool — local-API based creation for any collection.
  Mirrors `updateDocument`: pass `collection` + `data` (JSON string) and
  optionally `draft`. Defaults to `draft: true` for draft-enabled
  collections so newly created docs land in the same draft-first workflow
  as updates.

### Fixed
- Disabled the official plugin's `create<Resource>` tool universally for
  the same reason update was disabled in 0.3.2: the upstream schema
  converter falls back to `z.record()` for any collection containing
  richText, upload, blocks, or relationship-array fields. The fallback
  registers a metadata-only input schema, and the MCP SDK strips every
  content field before it reaches `payload.create()` — so creates always
  failed required-field validation with empty data. `createDocument`
  bypasses the converter entirely.

## [0.3.3] - 2026-05-04

### Fixed
- Globals now register with `enabled: { find: true, update: false }`. The
  official plugin's `update<Global>` tool hit the same schema-conversion
  bug as the collection variant (`Cannot convert undefined or null to
  object` from `Object.entries(convertedFields.shape)` on the
  `z.record()` fallback). Read access (`find`) still works; updates need
  to go through the admin panel until `updateDocument` gains global
  support (planned for 0.4).

## [0.3.2] - 2026-05-04

### Fixed
- The official plugin's per-collection raw `update<Resource>` tool is now
  disabled for every collection, not only `always-draft` ones. Previously,
  non-draftable collections containing `richText`, `upload`, or `blocks`
  fields crashed at registration time with
  `TypeError: convertedFields.partial is not a function` — the result of the
  upstream schema converter falling back to `z.record()` (which has no
  `.partial()`) when `json-schema-to-zod` chokes on those field types. The
  toolkit's `updateDocument` and `patchLayout` already cover updates via the
  local API for both draft and non-draft collections, so the broken raw tool
  is fully redundant.

### Changed
- `draftBehavior: 'always-publish'` no longer re-enables the official raw
  `update<Resource>` tool on a draftable collection. It still controls
  whether updates are saved as drafts vs. published immediately — but the
  update itself flows through `updateDocument`. Existing users who
  specifically depended on the raw tool for non-draft collections will need
  to switch to `updateDocument`.

## [0.3.0] - 2026-05-03

Major simplification pass. The plugin now works with zero config in the
typical case — every option became an optional escape hatch, and the
toolkit infers behavior from Payload's own configuration.

### Breaking changes
- `contentToolkitPlugin()` accepts no required options. The previous
  `siteUrl`, `previewSecret`, `previewPaths`, `sectionBlockSlugs` options
  are removed.
- `composePageLayout` tool removed. Use `patchLayout` (surgical) or
  `updateDocument` (full array) — both validate against the introspected
  block nesting map at any depth.
- Section/leaf block classification is gone. Blocks are now a single flat
  catalog; nesting is described by a per-blocks-field allow list (the new
  `blocks://nesting` resource), which works for arbitrary depth.
- `excludeCollections` / `excludeGlobals` moved into `exclude.collections` /
  `exclude.globals`.
- Preview URLs now come from each collection's own
  `admin.livePreview.url` or `admin.preview` function — no toolkit-side
  path map. Draft responses without a configured preview URL fall back to
  a generic admin-panel hint.

### Added
- `blocks://nesting` MCP resource — for every blocks-typed field anywhere
  in the schema, lists the slugs that field accepts. Drives recursive
  block validation in `patchLayout` and lets AI clients compose nested
  layouts at any depth.
- `userCollection` option — passthrough override for the auth collection
  used by the official plugin's API key linkage. Defaults to
  `admin.user` (Payload's own canonical setting).
- `preview.disabled` option to suppress preview URL injection entirely.

### Changed
- Draft behavior is now inferred from `versions.drafts`: enabled →
  `always-draft`, disabled → publish immediately. Override via the
  `draftBehavior` map only when you specifically need raw publish on a
  draftable collection.
- `patchLayout` validates each block recursively against the nesting map.
  Pass arbitrarily-deep nested `blocks` arrays in a single call.
- Auth-enabled collections are no longer manually excluded — the toolkit
  detects `auth: true` and skips them.

### Removed
- `composePageLayout` tool.
- `compose-helpers.ts` and `compose-layout.ts` source files.
- `SectionBlockSchema`, `LeafBlockSchema`, `BlockNestingType` exports —
  replaced by the flat `BlockSchema` and `BlockNestingMap`.

## [0.2.0] - 2026-05-03

### Added
- `listVersions` / `restoreVersion` — recent saved versions per draft document
  and one-call rollback. Restoring creates a new version on top, so the
  operation is itself reversible.
- `patchLayout` — surgical `append` / `prepend` / `insertAt` / `replaceAt`
  against a doc's block-array field without round-tripping the entire array.
- `safeDelete` — relationship-aware delete that walks the introspected graph
  and refuses with a structured impact summary if other docs reference the
  target. Override with `confirm: true`.
- `searchContent` — editor triage by `status`, `olderThanDays` /
  `newerThanDays`, `missingFields`, free-text `query`, scoped to one
  collection or all.
- `schedulePublish` — stamps a future `publishedAt` on a draft. **Bring your
  own scheduler** (Payload Jobs Queue, external cron, or `beforeRead` hook).
  Auto-registered only for collections that have both drafts AND a
  `publishedAt` date field.
- `sectionBlockSlugs` option to classify fixed-section blocks unambiguously.

### Fixed
- Section/leaf classification heuristic mis-labelled "fixed" sections (no
  nested `blocks` field). The new `sectionBlockSlugs` option provides an
  explicit override.
- Dev harness boots end-to-end; generated import map committed for the
  Lexical editor entries.

## [0.1.0] - initial scaffold

- Schema introspection, prompts, resources, draft workflow.
- Tools: `composePageLayout`, `updateDocument`, `uploadMedia`,
  `resolveReference`, `publishDraft`.
