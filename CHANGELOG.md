# Changelog

All notable changes are tracked here. The format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/).

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
