# payload-mcp-toolkit

> Schema-aware MCP toolkit for Payload CMS — wraps the official [`@payloadcms/plugin-mcp`](https://github.com/payloadcms/payload/tree/main/packages/plugin-mcp) with introspected prompts, resources, draft workflow, and AI-friendly tools so non-technical editors can manage content via AI chat.

## What it does

The official Payload MCP plugin gives every collection a generic CRUD surface. That works, but an LLM driving it has no idea:

- which collections support drafts vs publish-immediately,
- which block types are valid inside which sections,
- which fields are searchable for resolving relationships,
- how to compose a page layout without trial and error.

`payload-mcp-toolkit` introspects the Payload config at boot, then layers schema-aware **prompts**, **resources**, and **tools** on top of the official plugin so an AI client (Claude Desktop, Claude API, any MCP-compatible chat) can drive your CMS confidently.

## What it adds

**Auto-generated prompts** (no setup required):
- `contentModelOverview` — every collection, fields, and relationships.
- `blockCompositionGuide` — section/leaf hierarchy and nesting rules.
- `draftWorkflowGuide` — which collections need `publishDraft` to go live.

**Auto-generated resources** (machine-readable JSON for the LLM):
- `blocks://catalog`, `collections://schema`, `collections://relationships`.

**Custom tools (10, plus an auto-registered scheduler)**

*Authoring*
- `patchLayout` — surgical append/prepend/insertAt/replaceAt against any blocks-typed field. Validates each block (recursively, at any depth) against the introspected nesting map. Safer than `updateDocument` for incremental layout edits.
- `updateDocument` — Local-API based update that survives the upload-field bug in the official plugin.
- `uploadMedia` — fetch a public HTTPS image, validate (SSRF-safe with streaming size cap), create a Media doc.

*Discovery*
- `resolveReference` — search collections by name/title/slug for relationship IDs.
- `searchContent` — natural-language editor triage. Filter by `status`, `olderThanDays` / `newerThanDays`, `missingFields`, free-text `query`, scoped to one collection or all.

*Lifecycle / safety*
- `publishDraft` — flip `_status` from draft to published.
- `schedulePublish` — **bring your own scheduler.** Stamps a future `publishedAt` on a draft and leaves `_status: 'draft'`; it does **not** itself flip status at the appointed time. Auto-registered only for collections that have both drafts AND a `publishedAt` date field. Wire up a [Payload Jobs Queue task](https://payloadcms.com/docs/jobs-queue/scheduled-jobs), external cron, or `beforeRead` hook to actually publish on schedule.
- `listVersions` — recent saved versions of a draft document.
- `restoreVersion` — roll a document back to a saved version (creates a new version on top, so reversible).
- `safeDelete` — relationship-aware delete. Walks the relationship graph, refuses with a structured impact summary if other documents reference the target. Fail-closed on permission errors. Override with `confirm: true`.

**Draft workflow** wired into the official plugin's `mcpCollections`:
- For collections with `versions.drafts` enabled, disables raw `update` so clients go through `publishDraft` / `patchLayout` / `updateDocument` (all of which preserve draft semantics).
- Appends preview URLs to draft responses by calling each collection's own `admin.livePreview.url` or `admin.preview` function — no separate path config needed.

## Install

```bash
pnpm add payload-mcp-toolkit @payloadcms/plugin-mcp
```

Peer dependencies: `payload` ^3, `@payloadcms/plugin-mcp` ^3, `zod` ^3.

## Use — zero config

```ts
// payload.config.ts
import { contentToolkitPlugin } from 'payload-mcp-toolkit'

export default buildConfig({
  // ...your collections, blocks, globals
  serverURL: process.env.SITE_URL,                 // used for absolute preview URLs
  admin: { user: 'users' },                        // your auth collection
  plugins: [contentToolkitPlugin()],
})
```

That's it. The toolkit infers everything from your Payload config:
- **Draft behavior** — collections with `versions.drafts` get `always-draft` (raw update locked); others publish immediately.
- **Preview URLs** — pulled from each collection's `admin.livePreview.url` (or `admin.preview` as a fallback). If neither is set, draft responses just get a generic admin-panel hint.
- **Block nesting** — for every blocks-typed field, anywhere in the schema, the toolkit records which slugs are allowed. The AI composes layouts at any depth from that map.
- **Auth collection** — comes from `admin.user` (the standard Payload setting). The official plugin handles this directly.

## Optional configuration

Every option is an escape hatch — pass only what you need:

```ts
contentToolkitPlugin({
  preview: {
    siteUrl: 'https://staging.example.com', // override serverURL
    disabled: false,                        // set true to suppress preview URLs entirely
  },
  draftBehavior: {
    posts: 'always-publish',  // allow raw update on a draftable collection
  },
  userCollection: 'admins',  // override admin.user
  exclude: {
    collections: ['internal-bookkeeping'],
    globals: ['secret-config'],
  },
  mediaUpload: {
    maxFileSize: 25 * 1024 * 1024,
    collectionSlug: 'images',
  },
  domainPrompts: [
    {
      name: 'siteVocabulary',
      title: 'Site Vocabulary',
      description: 'Site-specific terms the AI should know.',
      content: '...',
    },
  ],
})
```

| Option | Description |
|---|---|
| `preview.siteUrl` | Base URL for preview links. Defaults to `serverURL`, then `NEXT_PUBLIC_SERVER_URL`/`SITE_URL` env vars. |
| `preview.disabled` | Suppress preview URL injection on draft responses. |
| `draftBehavior` | Per-collection override of inferred behavior. |
| `userCollection` | Override `admin.user` for API key linkage. |
| `exclude.collections` / `exclude.globals` | Hide from MCP exposure. |
| `domainPrompts` | Site-specific vocabulary prompts. |
| `mediaUpload.maxFileSize` | Default 10MB. Enforced as a streaming cap, not a post-buffer check. |
| `mediaUpload.collectionSlug` | Default `'media'`. |

## Development

This package follows the [official Payload 3 plugin template](https://github.com/payloadcms/payload/tree/main/templates/plugin) layout: source in `src/`, a fully-working Payload + Next.js app in `dev/`, source-export `package.json` so the dev harness consumes the plugin directly without a build step.

```bash
pnpm install
cp dev/.env.example dev/.env
pnpm dev          # boot dev/ Next.js + Payload at http://localhost:3000
pnpm test         # vitest — runs introspection unit tests
pnpm build        # produce dist/ for npm publish
```

The dev harness ships with a realistic CMS schema:
- `Pages` — block-based layout (FullWidth, TwoColumn, CtaBanner, HeadingOnly), drafts enabled.
- `Posts` — title/slug/excerpt/content/cover/category/authors/tags/SEO, drafts enabled.
- `Authors`, `Categories`, `Media`, `Users` — taxonomy + auth.
- `SiteSettings` — global with site name, logo, social, footer.
- 5 leaf blocks (Heading, RichText, Image, ButtonGroup, Quote) and 4 section blocks.

Seed sample content:

```bash
# Generate the admin import map first time:
pnpm dev:generate-importmap

# Then visit http://localhost:3000/admin and create your first user.
```

## License

MIT
