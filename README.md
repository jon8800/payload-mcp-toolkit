# payload-mcp-toolkit

> Standalone schema-aware MCP plugin for Payload CMS v3. Owns the `/api/mcp` endpoint, scoped API keys, draft workflow, and AI-friendly authoring tools so non-technical editors can manage content via AI chat.

`payload-mcp-toolkit` is a single, self-contained Payload v3 plugin. It introspects your Payload config at boot, registers schema-aware **prompts**, **resources**, and **tools** for any MCP-compatible client (Claude Desktop, Claude API, Continue, Cline), and exposes them over `POST /api/mcp` with bearer-token authentication on a built-in API-keys collection.

It is the standalone successor to the toolkit's earlier wrapper around `@payloadcms/plugin-mcp` — see [Upgrading from 0.3.x](#upgrading-from-03x) below.

## Install

```bash
pnpm add payload-mcp-toolkit
```

Peer dependencies: `payload` ^3, `zod` ^3.

## Configure — zero config

```ts
// payload.config.ts
import { contentToolkitPlugin } from 'payload-mcp-toolkit'

export default buildConfig({
  // ...your collections, blocks, globals
  serverURL: process.env.SITE_URL,        // used for absolute preview URLs + Host check
  admin: { user: 'users' },               // your auth collection
  plugins: [contentToolkitPlugin()],
})
```

That is the entire integration. The toolkit:

- Adds the `payload-mcp-api-keys` collection (admin UI: **MCP → API Keys**).
- Registers a bearer authentication strategy on your user collection.
- Mounts `POST /api/mcp` and `GET /api/mcp` (the latter returns 405 with a JSON-RPC error so probing clients see something useful).
- Builds tools / prompts / resources from your introspected schema.

Everything else is inferred:

- **Draft behavior** — collections with `versions.drafts` get `always-draft` semantics (clients flow through `publishDraft` / `patchLayout` / `updateDocument`); others publish immediately.
- **Preview URLs** — pulled from each collection's `admin.livePreview.url` (or `admin.preview` as a fallback). Falls back to a generic admin-panel hint when neither is set.
- **Block nesting** — recorded for every blocks-typed field anywhere in the schema; the AI composes layouts at any depth from that map.
- **User collection** — `admin.user`.

## API keys

Create one in admin (**MCP → API Keys → Create**). The plaintext key is shown once on creation; from then on only its `keyPrefix` (first 8 chars) is visible.

Authenticate every MCP request with:

```http
POST /api/mcp HTTP/1.1
Authorization: Bearer <plaintext-key>
Content-Type: application/json
```

### Scopes

Configure each key's permissions through typed admin fields — no JSON to hand-edit.

| Field | Effect |
|---|---|
| `preset` | Role preset: **Read-only**, **Editor** (read + create + update; denies `safeDelete` / `deleteDocument`), **Admin** (all actions), or **Custom** (use the override fields below). Required. Defaults to **Custom** so new keys deny everything until explicitly scoped. |
| `collectionScopes` | Array of `{ collection, actions[] }`. Only honoured when preset is **Custom**. Each row whitelists a collection and the actions allowed on it. An empty `actions[]` denies all actions on that collection. Listed collections are a *whitelist* — collections not in the list are denied. |
| `toolAllow` | Multi-select. Only honoured when preset is **Custom**. If set, only these tools are callable with this key. |
| `toolDeny` | Multi-select. Always applied on top of any preset. Tools listed here are blocked regardless of preset / collection scopes. |

The collection and tool dropdowns are populated at plugin-init time from your live Payload config + the toolkit's registered tools. Adding a collection or custom tool requires a dev-server / app restart for it to surface in the dropdowns.

The same shape is editable programmatically via Payload's REST and GraphQL APIs against the `payload-mcp-api-keys` collection — useful for seeding keys from CI or scripted provisioning.

### Lifecycle fields

| Field | Effect |
|---|---|
| `name`, `description` | Human-readable identifier in the admin list. |
| `expiresAt` | Authentication rejects keys past this date. |
| `revokedAt` | Authentication rejects keys when set. |
| `lastUsedAt` | Updated fire-and-forget on each successful auth. |
| `keyPrefix` | First 8 chars of the plaintext, for audit-log identification. |

## What the plugin adds

**Auto-generated prompts:**

- `contentModelOverview` — every collection, fields, and relationships.
- `blockCompositionGuide` — section/leaf hierarchy and nesting rules.
- `draftWorkflowGuide` — which collections need `publishDraft` to go live.

**Auto-generated resources:** `blocks://catalog`, `collections://schema`, `collections://relationships`.

**Tools (13, plus an auto-registered scheduler):**

*Authoring*
- `createDocument` — local-API based creation for any collection. JSON-string `data`. Defaults to `draft: true` on draft-enabled collections.
- `updateDocument` — local-API based update. Replaces the upstream plugin's `update<Resource>` tools, which crash on collections containing richText/upload/blocks fields.
- `patchLayout` — surgical append/prepend/insertAt/replaceAt against any blocks-typed field. Validates each block recursively against the introspected nesting map.
- `uploadMedia` — fetch a public HTTPS image, validate (SSRF-safe with a streaming size cap), create a Media doc.

*Discovery*
- `findDocument` — read documents by `id` or `where` filter, polymorphic across collections. Decorates draft responses with preview URLs when configured.
- `resolveReference` — search collections by name/title/slug for relationship IDs.
- `searchContent` — natural-language editor triage (status, recency, missing fields, free text).

*Lifecycle / safety*
- `publishDraft` — flip `_status` from draft to published.
- `schedulePublish` — auto-registered for collections with drafts AND a `publishedAt` date field. Stamps a future `publishedAt`; you wire up the actual flip via Payload Jobs Queue / cron / `beforeRead`.
- `listVersions` — recent saved versions of a draft document.
- `restoreVersion` — roll a document back to a saved version (creates a new version, so reversible).
- `safeDelete` — relationship-aware delete. Walks the relationship graph; refuses with a structured impact summary if the doc has inbound references. Override with `confirm: true`.
- `deleteDocument` — fast unsafe delete (no relationship walk). Use only when you know the doc has no inbound references; prefer `safeDelete` for general use.

## Optional configuration

Every option is an escape hatch — pass only what you need:

```ts
contentToolkitPlugin({
  auth: {
    allowedOrigins: ['https://app.example.com'],   // browser MCP clients only; defaults to no-CORS
  },
  apiKeyCollection: {
    slug: 'mcp-keys',                              // default 'payload-mcp-api-keys'
    userCollection: 'admins',                      // default admin.user
  },
  preview: {
    siteUrl: 'https://staging.example.com',
    disabled: false,
  },
  draftBehavior: {
    posts: 'always-publish',                       // publish immediately on update
  },
  userCollection: 'admins',
  exclude: {
    collections: ['internal-bookkeeping'],
    globals: ['secret-config'],
  },
  mediaUpload: { maxFileSize: 25 * 1024 * 1024, collectionSlug: 'images' },
  domainPrompts: [
    { name: 'siteVocabulary', title: 'Site Vocabulary', description: 'Site-specific terms.', content: '...' },
  ],
})
```

| Option | Description |
|---|---|
| `auth.allowedOrigins` | Origins permitted on the `Origin` header. Empty / unset means server-to-server only (no browsers). `*` is intentionally not honoured. |
| `apiKeyCollection.slug` | API-keys collection slug. Defaults to `payload-mcp-api-keys` for zero-touch upgrade compatibility. |
| `apiKeyCollection.userCollection` | User collection that API keys link to. Defaults to `userCollection` / `admin.user`. |
| `preview.siteUrl` | Base URL for preview links. Defaults to `serverURL`, then `NEXT_PUBLIC_SERVER_URL`/`SITE_URL` env vars. |
| `preview.disabled` | Suppress preview URL injection on draft responses. |
| `draftBehavior` | Per-collection override of inferred behavior. |
| `userCollection` | Override `admin.user` for API key linkage. |
| `exclude.collections` / `exclude.globals` | Hide from MCP exposure. |
| `domainPrompts` | Site-specific vocabulary prompts. |
| `mediaUpload.maxFileSize` | Default 10MB. Enforced as a streaming cap, not a post-buffer check. |
| `mediaUpload.collectionSlug` | Default `'media'`. |

## Upgrading from 0.3.x

v0.3.x wrapped `@payloadcms/plugin-mcp`. v0.4 owns the small remaining surface (transport, auth, API-key collection, find/delete) directly. The migration is short.

1. **Remove the upstream plugin** from `plugins[]`:
   ```diff
   - import { mcpPlugin } from '@payloadcms/plugin-mcp'
   - // ...
   - plugins: [contentToolkitPlugin(), mcpPlugin({ ... })],
   + plugins: [contentToolkitPlugin()],
   ```
2. **Drop the dependency** from `package.json`:
   ```bash
   pnpm remove @payloadcms/plugin-mcp
   ```
3. **Existing API keys keep authenticating zero-touch.** The `payload-mcp-api-keys` slug, `apiKey` / `apiKeyIndex` columns, and HMAC formula are all preserved.
4. **Re-scope each key** — see the [API keys](#api-keys) section. Open each existing key in admin, pick a preset (or **Custom** with explicit collection / tool overrides), and save. Until you do, keys carry no scopes and authenticate at full access.
5. **CORS defaults to no-browsers.** If you have a browser-based MCP client, set `auth.allowedOrigins`. Server-to-server callers (no `Origin` header) are always allowed and require no opt-in.

If you forget step 1, the plugin throws on boot with the same message — it refuses to register two MCP plugins racing for the `payload-mcp-api-keys` slug.

## Development

This package follows the [official Payload 3 plugin template](https://github.com/payloadcms/payload/tree/main/templates/plugin) layout: source in `src/`, a fully-working Payload + Next.js app in `dev/`, source-export `package.json` so the dev harness consumes the plugin directly without a build step.

```bash
pnpm install
cp dev/.env.example dev/.env
pnpm dev          # boot dev/ Next.js + Payload at http://localhost:3000
pnpm test         # vitest — runs the unit + integration suite
pnpm build        # produce dist/ for npm publish
```

The dev harness ships with a realistic CMS schema:

- `Pages` — block-based layout (FullWidth, TwoColumn, CtaBanner, HeadingOnly), drafts enabled.
- `Posts` — title/slug/excerpt/content/cover/category/authors/tags/SEO, drafts enabled.
- `Authors`, `Categories`, `Media`, `Users` — taxonomy + auth.
- `SiteSettings` — global with site name, logo, social, footer.
- 5 leaf blocks (Heading, RichText, Image, ButtonGroup, Quote) and 4 section blocks.

## License

MIT
