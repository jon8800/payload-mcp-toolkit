# Changelog

All notable changes are tracked here. The format roughly follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/).

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
