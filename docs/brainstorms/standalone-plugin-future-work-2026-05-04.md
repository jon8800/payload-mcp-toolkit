---
title: Standalone plugin — future work (post-v0.4)
date: 2026-05-04
status: brainstorm
module: payload-mcp-toolkit
problem_type: roadmap
applies_when:
  - Considering features deferred from the standalone v0.4 release
  - Planning the moat-deepening direction beyond transport ownership
tags: [payload-cms, mcp, roadmap, future-work]
---

# Standalone plugin — future work

These items were considered during the standalone-plugin brainstorm (`standalone-plugin-2026-05-04.md`) and explicitly deferred. They represent the **moat-deepening** direction the toolkit can take *after* the transport-ownership migration stabilizes — and they should not be allowed to anchor scope at the v0.4 decision point.

Each item carries a rough cost estimate so the trade-offs are visible.

## 1. Admin UI panel for API key management

**Cost: 5–8 days.**

Replace the basic Payload collection list view for `payload-mcp-api-keys` with a custom admin panel. Surface: per-key creation flow with one-time key disclosure, per-key tool/collection enable matrix (paired with the scoped-authz model in the security spec), per-key audit log view, "rotate key" affordance.

Why deferred: requires React component work inside Payload's admin SSR boundary, asset bundling via `admin.components`, custom collection view, and the scoped-authz dispatch model (which itself isn't shipping in v0.4). The "tool I want my clients to use" pitch is real but reads as a v0.5+ play — premature before the standalone transport is stable.

Prerequisite: scoped per-key authorization model lands (see Security Requirements in the parent brainstorm).

## 2. CLI / browser playground for testing tools

**Cost: 3–5 days.**

A standalone tool — CLI binary (`pnpx payload-mcp-toolkit play`) or a small Vite-served web app — that connects to a running Payload + MCP endpoint and lets a developer invoke each registered MCP tool with a JSON arg blob, view the result, and inspect the schema. Big DX win for plugin authors and content-engineers debugging AI flows.

Why deferred: separate artifact with its own bundling/distribution surface (a `bin` entry, a separate package or sub-export), and useful only if the standalone transport is already stable. Premature before v0.4 ships.

Prerequisite: standalone v0.4 shipped and stable.

## 3. Code Connect–style per-collection narrative metadata

**Cost: 3–4 days.**

Extend the `domainPrompts` concept into per-collection narrative metadata: each collection declares a short description of "this is how AI should describe this collection to a human" (purpose, edit-affordances, example phrasings). Surfaces in `tools/list` descriptions and in `prompts/list` snippets so AI clients can give users domain-aware affordances rather than generic CRUD.

Why deferred: pure value-add layer atop the existing schema-aware authoring, not blocking on the standalone migration. Will land more cleanly once the standalone surface is stable and the option-shape is final. Should arrive with at least one consuming client (e.g., a Payload-aware MCP client) so the metadata format is informed by real usage, not designed in a vacuum.

Prerequisite: at least one external MCP client consuming the toolkit's tools to inform the metadata schema.

## 4. Hybrid typed inputSchema for simple-field collections

**Cost: 4–6 days.**

Upstream's converter approach has one genuine UX advantage when it doesn't crash: the AI client sees per-field tool parameters (`createPosts({ title, slug, status })`) instead of an opaque `data: string` JSON blob. For MCP clients that render tool schemas to users — Claude Desktop's tool inspector, future admin-UI playgrounds — that structured shape is materially better for transparency, prefill, and client-side validation.

The toolkit's local-API approach trades that UX away to survive richText/blocks/upload. Hybrid recovery: build a **conservative** schema-to-Zod converter that covers only the field types that round-trip cleanly (text/number/date/checkbox/email/select/textarea/code/json with simple shapes), and falls back to the `data: string` blob shape for any collection whose field tree contains richText / blocks / upload / relationship-array / `group` with nested complexity. Per-collection, the toolkit picks the typed shape when safe and the blob shape when not.

Why deferred: not blocking v0.4 (the blob shape works correctly for every collection, just less prettily). The hybrid pays off only after the standalone transport is stable and there's signal that AI clients are stumbling on the prose-only descriptions. Easier to design once we have audit-log data on which `data` shapes the AI actually emits — see the v0.4 audit log's "top-level keys logged" provision.

Why this is *not* a re-implementation of upstream's broken converter: scope is dramatically narrower (only the safe field types, no eval, no JSON-Schema indirection — direct field-config walk), and the fallback is to a known-good shape rather than `z.record(z.any())`.

Prerequisite: v0.4 ships and has been live long enough to gather signal on which collection shapes the AI struggles to emit through the blob.

## Why these stay parked

The risk these items pose to the standalone migration is anchoring: once the v0.4 spike succeeds, a parking lot of well-articulated next steps becomes the natural Day-2 milestone, and the 1–2 day standalone scope stretches into a 3–4 week capability expansion. Keeping them in a separate document — with explicit cost estimates and prerequisites — makes the trade-off visible at the decision point.

The fork is **lateral motion** (same capabilities, different ownership boundary). These items are **moat-deepening** (capabilities the wrapper architecture can't easily express). The order matters: ship the lateral move, stabilize, *then* deepen — don't bundle them.
