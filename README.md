# payload-mcp-toolkit

A Payload CMS v3 plugin that lets AI apps such as Claude and ChatGPT read and edit your content over MCP.

It reads your Payload config when the server starts and builds tools, prompts and resources from your collections, globals and blocks. It serves them at `/api/mcp`. Clients connect in one of two ways:

- **API keys** for scripts and local agents. Each key has its own permissions.
- **Website sign-in (OAuth)** for Claude and ChatGPT connectors. Users sign in with their site account and choose what the AI may do. Optional. See [docs/oauth.md](docs/oauth.md).

Payload access control applies to every call. Tools run as the signed-in user or the key's user, with `overrideAccess: false`.

## Install

```bash
pnpm add payload-mcp-toolkit
```

Peer dependencies: `payload` ^3, `@payloadcms/ui` ^3, `zod` ^3.25 or ^4.

```ts
// payload.config.ts
import { mcpToolkitPlugin } from 'payload-mcp-toolkit'

export default buildConfig({
  serverURL: process.env.SITE_URL, // used for preview links and the Host check
  admin: { user: 'users' },
  plugins: [mcpToolkitPlugin()],
})
```

This adds:

- The `payload-mcp-api-keys` collection (admin: **MCP → API Keys**) and a bearer strategy on your user collection.
- `POST /api/mcp`. `GET /api/mcp` returns 405.
- Tools, prompts and resources built from your schema.

The plugin works out the rest from your config:

- **Drafts:** collections and globals with `versions.drafts` save changes as drafts. Others publish on save.
- **Preview links:** taken from `admin.livePreview.url`, or `admin.preview`.
- **Blocks:** every blocks field, at any depth, so the AI can build valid layouts.

Schema changes add database tables or columns. On Postgres or SQLite with `push: false`, generate and commit a Payload migration after installing or upgrading.

## API keys

Create a key in **MCP → API Keys**. The admin shows the full key once. After that you see only its first 8 characters.

```http
POST /api/mcp
Authorization: Bearer <key>
Content-Type: application/json
```

Each key has a **preset**:

| Preset | Collections | Globals |
|---|---|---|
| Read-only | read | read |
| Editor | read, create, update | read |
| Admin | read, create, update, delete | read, update |
| Custom | only what you tick | only what you tick |

New keys start as **Custom** with nothing ticked, so they can do nothing until you choose. Custom gives you a collection matrix, a global matrix, a tool allow list and a tool deny list. The deny list applies to every preset.

Editor keys cannot change globals. One bad write to a global (site name, footer, navigation) shows on every page. To let a key edit a specific global, use Custom.

A key limited to some collections or globals also has these rules:

- It gets linked entries as IDs only.
- `findDocument` refuses filters with a dotted path.
- Search, reference and upload tools are off, because they reach across every collection.

Keys also have `expiresAt`, `revokedAt` and `lastUsedAt`.

## Website sign-in (OAuth)

```ts
mcpToolkitPlugin({
  oauth: {
    canAuthorize: ({ user }) => user?.role === 'admin', // who may connect; checked on every request
    access: 'editor', // most the site allows; default 'read-only'
  },
})
```

Users add `https://YOUR-SITE/api/mcp` as a custom connector in Claude, or in ChatGPT with Developer mode on. Then they sign in and approve access. The approve screen offers the same choices as a Custom key, capped at `access`. Delete and global writes are never allowed this way.

The plugin also adds:

- `/admin/mcp-connections`, where users copy the connector URL and agent instructions, and disconnect.
- A compact "Connect your AI agent" prompt in the admin sidebar.

Setup needs a migration, discovery rewrites and two security headers. See [docs/oauth.md](docs/oauth.md).

## Tools

Tools for versions and publishing appear only for collections and globals with drafts. Global tools appear only when the config has globals.

| Tool | What it does |
|---|---|
| `findDocument` | Read by ID or `where` filter. Draft results include a preview link. |
| `searchContent` | Find entries by text, status, recent changes or missing fields. |
| `resolveReference` | Look up IDs by name, title or slug, for relationship fields. |
| `createDocument` | Create an entry. Draft collections save a draft. |
| `updateDocument` | Update an entry, including rich text, upload and blocks fields. |
| `patchLayout` | Append, insert or replace blocks in a blocks field. Checks each block against your schema. |
| `uploadMedia` | Fetch a public HTTPS image and create a media entry. Size-capped while downloading. |
| `publishDraft`, `schedulePublish` | Publish a draft now, or set a future `publishedAt`. You run the scheduled publish yourself (Jobs Queue or cron). |
| `listVersions`, `restoreVersion` | List saved versions and roll back. |
| `safeDelete` | Delete only if nothing links to the entry, unless `confirm: true`. |
| `deleteDocument` | Delete without checking links. |
| `findGlobal`, `updateGlobal`, `patchGlobalLayout` | The same for globals. |
| `publishGlobalDraft`, `listGlobalVersions`, `restoreGlobalVersion` | Draft tools for globals. |

**Prompts:** `contentModelOverview`, `blockCompositionGuide`, `draftWorkflowGuide`.

**Resources:** `collections://schema`, `collections://relationships`, `blocks://catalog`, `blocks://nesting`, `globals://schema`.

## Options

| Option | Description |
|---|---|
| `oauth` | Website sign-in. See above. |
| `exclude.collections`, `exclude.globals` | Hide collections and globals from MCP. |
| `customTools` | Your own tools. See below. |
| `draftBehavior` | Per-collection override, for example `{ posts: 'always-publish' }`. |
| `preview.siteUrl`, `preview.disabled` | Base URL for preview links (default `serverURL`), or turn them off. |
| `mediaUpload.maxFileSize`, `mediaUpload.collectionSlug` | Default 10 MB and `'media'`. |
| `domainPrompts` | Extra prompts with site vocabulary. |
| `userCollection` | Override `admin.user`. |
| `apiKeyCollection.slug`, `apiKeyCollection.userCollection` | Rename the keys collection or link keys to another user collection. |
| `auth.allowedOrigins` | Origins allowed by the `Origin` check. Unset means server-to-server only. |

## Custom tools

```ts
import { mcpToolkitPlugin, jsonResponse, type ToolFactoryOutput } from 'payload-mcp-toolkit'
import { z } from 'zod'

const countActiveMembers: ToolFactoryOutput = {
  name: 'countActiveMembers',
  description: 'Number of members with an active membership.',
  parameters: { since: z.string().optional().describe('ISO date.') },
  routing: { kind: 'account', action: 'read' },
  handler: async (args, req) => {
    const { totalDocs } = await req.payload.count({ collection: 'memberships', user: req.user, overrideAccess: false })
    return jsonResponse({ totalDocs })
  },
}

mcpToolkitPlugin({ customTools: [countActiveMembers] })
```

Custom tools go through the same permission check and audit log as the built-in tools. They also appear in the API-key and sign-in tool lists.

- **`routing`** says which permission gates the tool.
  - `collection` tools must take a required `collection` argument.
  - `global` tools must take a required `slug`.
  - Use `account` when the target is fixed in the handler or spans the whole site. Without the argument, a collection or global tool is always denied.
- **`handler`** should read `req.payload` and `req.user` on each call. Query with `user: req.user, overrideAccess: false`.
- **Names** must be unique. Reusing a built-in name throws at startup.

## Upgrading

- **0.8 → 0.9:** OAuth is new and off by default. Without it, nothing changes for API-key sites, except one rule. Keys limited to some collections or globals now get linked entries as IDs only, and `findDocument` refuses dotted filter paths for them. Regenerate your import map.
- **Older versions:** see [CHANGELOG.md](CHANGELOG.md).

## Known limitations

- Browser-based MCP clients are not supported yet. The endpoint does not send CORS headers or answer `OPTIONS` preflight. Server-to-server clients and hosted connectors (Claude, ChatGPT) are not affected.

## Development

The `dev/` folder is a working Payload and Next.js app that uses the plugin source directly.

```bash
pnpm install
cp dev/.env.example dev/.env
pnpm dev    # http://localhost:3000
pnpm test
pnpm build
```

## License

MIT
