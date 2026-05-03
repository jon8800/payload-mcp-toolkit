---
title: Infer plugin configuration from Payload's own schema, not parallel declaration
date: 2026-05-04
category: docs/solutions/architecture-patterns
module: payload-mcp-toolkit
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - Designing a Payload CMS plugin's configuration API
  - Building any framework plugin whose options would duplicate data the host framework already declares
  - Modeling block/composition systems where nesting depth is unknown or variable
  - Choosing between pre-classification (forcing developers to label things) and runtime schema inference
tags: [payload-cms, plugin-design, zero-config, schema-inference, block-system, mcp, dx]
---

# Infer plugin configuration from Payload's own schema, not parallel declaration

## Context

The toolkit's first two releases (v0.1, v0.2) shipped with a config object that asked the developer to declare information Payload's own config already carried. The minimum-working invocation looked like this:

```ts
contentToolkitPlugin({
  siteUrl: process.env.SITE_URL!,
  previewSecret: process.env.PREVIEW_SECRET!,
  previewPaths: { pages: '', posts: '/blog' },
  sectionBlockSlugs: ['fullWidth', 'twoColumn', 'ctaBanner', 'headingOnly'],
  draftBehavior: { pages: 'always-draft', posts: 'always-draft' },
})
```

Six required-or-near-required fields. Each one already had a source of truth elsewhere in the project:

| Plugin option | Source of truth in Payload |
|---|---|
| `siteUrl` | `buildConfig({ serverURL })` |
| `previewSecret` | The developer's own preview route — they already own this |
| `previewPaths` | `collection.admin.livePreview.url(args)` returns the path |
| `sectionBlockSlugs` | Every `blocks`-typed field already lists its allowed slugs |
| `draftBehavior` | `collection.versions.drafts` |
| `userCollection` (passthrough) | `buildConfig({ admin: { user } })` |

The plugin was asking the developer to **say things twice** — once in their Payload config, once in the plugin call. Each duplicate is a chance for the two to drift, and every required option is a barrier to the plugin's typical-case "just add it to the plugins array" promise.

The same problem showed up in the block model. The plugin classified blocks as either *sections* (top-level layout containers) or *leaves* (placed inside a section's `blocks` field). That two-tier model worked for simple sites but broke down when:

- A page has a single layout field with no nested layers (one tier)
- A "section" itself contains a `blocks` field whose contents can themselves contain more `blocks` fields (three or more tiers)
- Different `blocks` fields on the same page accept different allow lists

Payload's schema already encodes "this `blocks` field accepts these slugs." The plugin was imposing a fixed two-tier model on top of a schema that supports arbitrary nesting.

The result was a cluster of bespoke validation tools (`composePageLayout` with its `section` / `content` / `leftColumn` / `rightColumn` shape) that worked for the demo but couldn't represent the real variety of Payload setups.

## Guidance

**For framework plugins, treat the host framework's config as the primary declaration. Read it, infer behavior from it, and only accept plugin options as escape hatches for cases the inference can't cover.**

Three concrete moves that this redesign made:

### 1. Read what's already declared

For every plugin option, ask: "Is this information already in the host config, the request lifecycle, or the environment?" If yes, read it; don't ask again.

```ts
// Before: required option
contentToolkitPlugin({ siteUrl: 'https://example.com', ... })

// After: read serverURL from buildConfig with conventional fallbacks
const previewSiteUrl =
  options.preview?.siteUrl ??
  incomingConfig.serverURL ??
  process.env.NEXT_PUBLIC_SERVER_URL ??
  process.env.SITE_URL
```

The plugin still accepts `preview.siteUrl` for the rare case where the preview base differs from `serverURL` (staging URL, CDN-fronted preview), but the option becomes invisible in the typical path.

### 2. Delegate to the host's existing extension points

Payload already has a `livePreview.url` / `admin.preview` function that *the developer has already written* for the admin UI's preview button. The plugin can call the same function rather than asking for a `previewPaths` map:

```ts
const livePreviewUrl = collection.admin?.livePreview?.url
if (typeof livePreviewUrl === 'function') {
  raw = await livePreviewUrl({ data: doc, req, payload: req.payload, ... })
}
```

The plugin contributes nothing of its own to URL construction — it just invokes the function the developer maintains for another purpose. Two consequences: (a) zero new config to learn, (b) the preview link the AI returns matches the preview link the admin UI shows, by construction.

### 3. Represent the schema 1:1 instead of imposing a model on top of it

Replace pre-classification with introspection that reflects the schema's actual shape. For block composition specifically:

**Old model**: blocks are sections or leaves; sections have nestingType `composable | constrained | fixed`; leaves go inside sections.

**New model**: blocks are a flat catalog; for every `blocks`-typed field anywhere in the schema (in collections, inside blocks, inside arrays inside blocks, etc.), record `{owner, fieldPath, acceptedBlockSlugs, maxRows}`. The AI reads this map and composes layouts at any depth.

```ts
export interface BlockNestingEdge {
  owner: string                      // collection or block slug
  ownerType: 'collection' | 'block'
  fieldPath: string                  // dotted path, e.g. 'layout' or 'panels[].body'
  acceptedBlockSlugs: string[]
  maxRows?: number
}
```

The validator becomes a recursive walk: for each block in the input, look up the allow list for the position it sits in; recurse into any nested `blocks`-shaped arrays inside that block, looking up the allow list for *that* position. Works for one tier, two tiers, n tiers — same code path.

A whole tool (`composePageLayout`) and its helper module disappear because the validation collapses into the schema lookup. `patchLayout` and the existing `updateDocument` cover the same surface, and the AI reads the nesting map directly to know where each block can go.

## Why This Matters

**Compounding correctness.** When the plugin restates information the host already owns, the two declarations can — and eventually will — disagree. A draftable collection where someone forgot to add `'always-draft'` to the override map silently gets raw `update` enabled, defeating the whole point of the draft workflow. By inferring from `versions.drafts`, that class of bug stops being possible.

**Lower onboarding cost.** A plugin that needs zero arguments to demo is materially easier to evaluate than one with a six-field config wall. For a publish-and-share open-source plugin, the config wall directly suppresses adoption.

**Schema honesty for AI consumers.** When you pre-classify (sections vs leaves, or any imposed taxonomy), the AI gets a model that doesn't match the actual schema. It will compose things the model considers valid that Payload then rejects, or vice versa. Exposing the schema 1:1 — flat catalog plus per-field allow list — gives the AI the same view Payload's own validator uses.

**Smaller surface to maintain.** The simplification produced **−60 net lines** of source code (898 added, 958 deleted) across the rewrite. Two source files were deleted entirely (`compose-helpers.ts`, `compose-layout.ts`). One tool was deleted (`composePageLayout`). One config object shrank from six fields to one fully-optional escape-hatch object. The plugin does *more* now (handles arbitrary nesting depths it previously couldn't) with less code.

## When to Apply

- Building a plugin for a framework that already has structured config (Payload, Strapi, Sanity, Next.js middleware, etc.). Whenever a plugin option would restate what the framework already declares, read instead of asking.
- Designing the validation/introspection layer for AI- or codegen-driven tooling. The closer the model the plugin exposes is to the schema, the better the downstream consumer behaves.
- Modeling composition systems where the developer can't predict the nesting shapes upfront. A flat catalog + per-edge allow list scales; a fixed N-tier model doesn't.
- Reviewing a plugin's config API after the first real consumer integration — the second consumer will reveal which options were premature complexity.

## Examples

### Before — duplicated declaration, fixed two-tier block model

```ts
// In dev/payload.config.ts
plugins: [
  contentToolkitPlugin({
    siteUrl: process.env.SITE_URL || 'http://localhost:3000',
    previewSecret: process.env.PREVIEW_SECRET || 'preview-secret',
    previewPaths: { pages: '', posts: '/blog' },
    sectionBlockSlugs: ['fullWidth', 'twoColumn', 'ctaBanner', 'headingOnly'],
    draftBehavior: { pages: 'always-draft', posts: 'always-draft' },
    domainPrompts: [...],
  }),
],
```

Each declaration above had a corresponding declaration somewhere else in the same config that already carried the same information.

### After — inference primary, options as escape hatches only

```ts
// In dev/payload.config.ts
serverURL: process.env.SITE_URL || 'http://localhost:3000',
admin: { user: Users.slug },
collections: [
  // Pages.ts:
  {
    slug: 'pages',
    versions: { drafts: { autosave: { interval: 800 } } },  // → infers always-draft
    admin: {
      livePreview: { url: ({ data }) => `/${data.slug ?? ''}` },  // → preview path inferred
    },
    fields: [...],
  },
],
plugins: [
  contentToolkitPlugin({
    domainPrompts: [...],  // only thing the plugin can't infer — site-specific vocabulary
  }),
],
```

### Before — fixed two-tier validation, can't represent depth

```ts
// composePageLayout's input shape forced a two-tier model:
{
  sections: [
    { sectionType: 'twoColumn',
      leftColumn: [{ blockType: 'heading', fields: { text: 'Hi' } }],
      rightColumn: [{ blockType: 'image', fields: { ... } }],
    },
    { sectionType: 'ctaBanner', fields: { headline: 'Sign up' } },
  ]
}
```

A site whose pages are flat (single `layout` blocks field, no nesting) had to pretend it had sections. A site with three-tier nesting (accordion containing panels containing rich blocks) couldn't be expressed at all.

### After — flat blocks at any depth, recursive validation

```ts
// patchLayout takes raw block objects matching the schema:
{
  collection: 'pages',
  documentId: '...',
  layoutField: 'layout',
  blocks: [
    {
      blockType: 'accordion',
      panels: [
        { title: 'About',
          body: [
            { blockType: 'heading', text: 'Who we are', level: 'h2' },
            { blockType: 'fullWidth',
              content: [
                { blockType: 'richText', content: '...' }
              ]
            }
          ]
        }
      ]
    }
  ],
  operation: 'append',
}
```

Each `blocks`-shaped array is validated against the allow list for its specific position in the schema, recursing as deep as the schema permits. The validator code is roughly 30 lines and handles any structure Payload itself accepts.

### The introspection that makes this work

```ts
// At plugin init, walk every collection and every block recursively
// and record one BlockNestingEdge per blocks-typed field encountered.

buildBlockNestingMap(collections, blocks)
// Returns:
[
  { owner: 'pages',     ownerType: 'collection', fieldPath: 'layout',
    acceptedBlockSlugs: ['fullWidth', 'twoColumn', 'ctaBanner', 'accordion'] },
  { owner: 'fullWidth', ownerType: 'block',      fieldPath: 'content',
    acceptedBlockSlugs: ['heading', 'richText', 'image'] },
  { owner: 'accordion', ownerType: 'block',      fieldPath: 'panels[].body',
    acceptedBlockSlugs: ['heading', 'richText', 'fullWidth'] },
  // …
]
```

This map is exposed verbatim as the `blocks://nesting` MCP resource, so AI clients reason about composition with the same data the validator uses.

## Related

- `payload-mcp-toolkit` v0.3.0 release commit and CHANGELOG entry
- Upstream pattern: `@payloadcms/plugin-mcp` itself falls back to `incomingConfig.admin.user` when its own `userCollection` option is omitted — the same "read what's already declared" instinct, applied at one level deeper
