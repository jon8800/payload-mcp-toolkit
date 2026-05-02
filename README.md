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

**Custom tools**:
- `composePageLayout` — build a validated page layout from sections + leaves.
- `publishDraft` — flip `_status` from draft to published.
- `resolveReference` — search collections by name/title/slug for relationship IDs.
- `updateDocument` — Local-API based update that survives the upload-field bug in the official plugin.
- `uploadMedia` — fetch a public HTTPS image, validate (SSRF-safe), create a Media doc.

**Draft workflow** wired into the official plugin's `mcpCollections`:
- Disables raw `update` for `always-draft` collections so clients go through `publishDraft`.
- Appends preview URLs to draft responses (path prefixes are configurable via `previewPaths`).

## Install

```bash
pnpm add payload-mcp-toolkit @payloadcms/plugin-mcp
```

Peer dependencies: `payload` ^3, `@payloadcms/plugin-mcp` ^3, `zod` ^3.

## Use

```ts
// payload.config.ts
import { contentToolkitPlugin } from 'payload-mcp-toolkit'

export default buildConfig({
  // ...your collections, blocks, globals
  plugins: [
    contentToolkitPlugin({
      siteUrl: process.env.SITE_URL!,
      previewSecret: process.env.PREVIEW_SECRET!,
      previewPaths: {
        pages: '',          // pages live at /
        posts: '/blog',     // posts live at /blog/:slug
      },
      draftBehavior: {
        pages: 'always-draft',
        posts: 'always-draft',
      },
      domainPrompts: [
        // Optional site-specific vocabulary — see examples/
      ],
    }),
  ],
})
```

That's it. The toolkit reads your Payload config and registers everything against the official MCP plugin. Connect any MCP client to your Payload server and the LLM will see the prompts, resources, and tools.

See `examples/angels-config.example.ts` for a fully-worked domain-prompt setup from a real-world site.

## Configuration reference

| Option | Type | Description |
|---|---|---|
| `siteUrl` | `string` | Base URL used to construct preview URLs. |
| `previewSecret` | `string` | Secret embedded in the preview URL query. |
| `previewPaths` | `Record<string, string>` | Per-collection URL path prefix. Defaults to `/{slug}` if omitted. Use `''` for collections at the site root. |
| `draftBehavior` | `Record<string, 'always-draft' \| 'always-publish'>` | Override the default draft behavior per collection. |
| `domainPrompts` | `DomainPrompt[]` | Custom prompts that teach the AI site-specific vocabulary. |
| `mediaUpload.maxFileSize` | `number` | Max bytes for `uploadMedia` (default 10MB). |
| `mediaUpload.collectionSlug` | `string` | Media collection slug (default `media`). |
| `excludeCollections` | `string[]` | Collection slugs to hide from MCP. |
| `excludeGlobals` | `string[]` | Global slugs to hide from MCP. |

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
