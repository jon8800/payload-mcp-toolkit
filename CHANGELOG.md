# Changelog

All notable changes are tracked here. The format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/).

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
