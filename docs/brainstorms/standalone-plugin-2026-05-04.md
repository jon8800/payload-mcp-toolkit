---
title: Make payload-mcp-toolkit a standalone plugin (drop @payloadcms/plugin-mcp dep)
date: 2026-05-04
status: brainstorm
module: payload-mcp-toolkit
problem_type: architecture_decision
applies_when:
  - Considering whether to keep wrapping @payloadcms/plugin-mcp or replace it entirely
  - Evaluating ongoing cost of routing around upstream bugs vs. one-time cost of owning the transport layer
tags: [payload-cms, mcp, architecture, plugin-design, dependency-strategy]
---

# Make payload-mcp-toolkit a standalone plugin

## The premise

Stop wrapping `@payloadcms/plugin-mcp`. Reimplement the small parts of it we actually use, drop it as a dependency, ship the toolkit as a complete MCP plugin in its own right — keeping the existing `payload-mcp-toolkit` name and npm identity.

## Why this came up

The 0.3.x release cycle has been a sequence of patches that each disable another piece of the official plugin's per-collection CRUD surface, because the **authoring path** of that surface is structurally unfit for Payload's domain:

- 0.3.2 — disable official `update<Resource>` for all collections (crashes on richText/upload/blocks/relationship-array fields)
- 0.3.3 — disable official `update<Global>` (same crash class)
- 0.3.4 — disable official `create<Resource>` (silently strips fields, payloads land empty)

The toolkit now ships its own `createDocument`, `updateDocument`, `patchLayout` — *schema-aware tools* (i.e. they introspect Payload's collection config to know which slugs/fields/blocks exist, and use the local API to write them) that bypass the upstream pipeline entirely. What's left of the official plugin in our setup is essentially:

- HTTP endpoint registration (`/api/mcp` POST/GET)
- API key collection (`payload-mcp-api-keys`) + bearer auth strategy
- MCP `tools/list` / `tools/call` / `resources/list` / `resources/read` / `prompts/list` plumbing
- Per-collection / per-global `enabled` flags for `find` / `delete` (we already disabled `create` and `update`)

That is a small, well-defined surface. Nothing about it is Payload-domain-specific in a way the toolkit couldn't do better.

## Why the official plugin's authoring path is structurally broken

> Scope of "broken": this critique applies specifically to the `create<Resource>` / `update<Resource>` / `update<Global>` authoring tools. The transport, auth, and `find<Resource>` paths are not converter-affected (see Risks §C-1).

The architectural choice was: take Payload's auto-generated JSON Schema for a collection, run it through the third-party `json-schema-to-zod` library, `eval()` the resulting source, use that Zod schema as the MCP tool's input schema.

This works for trivial collections (text, number, date). It fails the moment Payload-native field types appear:

- `richText` (Lexical) — recursive, dynamic shape; converter throws.
- `upload` / `relationship` — refs that don't round-trip through generic JSON Schema.
- `blocks` — discriminated unions of arbitrary depth; converter doesn't support them.
- `array` of relationships, `group` with nested arrays, etc.

The catch-block fallback is `z.record(z.any())`, which doesn't satisfy the contract the caller code expects (`.partial()`, `.shape`). So the fallback is itself broken.

Even if the fallback were fixed, the philosophical problem remains: **trying to derive a complete validation schema from a JSON-Schema dump of an expressive CMS is the wrong abstraction layer.** Payload's own local API is the source of truth — no translation needed, no shape mismatches, no schema-converter fragility.

The toolkit already proves the alternative: `createDocument` / `updateDocument` accept a JSON `data` string (validated as JSON only) and call `payload.create()` / `payload.update()` directly. The local API does its own validation, returns its own errors, handles drafts/locales/relationships natively. No conversion. No eval. No surprises.

## What "standalone" buys

- **One failure surface, not two.** Right now bugs can come from upstream OR from us. Standalone, every bug is ours to fix on our cadence.
- **Coherent docs.** Today's README is half "how the toolkit works" and half "which official plugin features we override and why." Standalone, it's just one story.
- **Faster releases.** No coupling to Payload's monorepo release cadence. We follow Payload's *peer* version, not its plugin's.
- **Cleaner config.** No more passing through to `mcpPlugin({ collections, globals, ... })` shapes that include flags (`create`, `update`) we always set to false.
- **Honesty about the design.** The toolkit's identity is "AI-friendly authoring, schema-aware, local-API-based." That's a different abstraction from the official plugin's "generic CRUD over MCP." Pretending we extend the latter when we route around it has costs.

## Alternatives considered

Before committing to a fork, three lower-cost alternatives deserve explicit evaluation:

### (a) Upstream contribution — submit a PR replacing the converter path

We already have the working solution (local-API authoring). A PR upstreaming `convertCollectionSchemaToZod` → local-API would fix the problem for the entire Payload ecosystem, not just toolkit users. **Verdict: rejected.** Web research (2026-05-04) found no upstream PR/issue/RFC acknowledging the converter as architecturally wrong. The Payload team's response pattern to related breakage (Zod v4 compat, union-type failures) has been narrow patches preserving the same converter, and a source comment frames `new Function()` eval as intentional. v3.83's extension hook for external plugins to inject custom tools signals "work around us if you need to" — which is exactly what this toolkit has been doing. A maintainer-rejected PR would be worse than not submitting one. Worth revisiting if upstream signals change (see falsification rule under Risks §A-1).

### (b) Minimal upstream change request — flag to disable broken authoring tools

Ask upstream to add a `disableAuthoringTools: true` config option that turns off `create<Resource>`/`update<Resource>`/`update<Global>` registration entirely, leaving find/delete + transport intact. Cheaper than (a) since it doesn't require architectural agreement. **Verdict: hold.** v3.83 already added a generic extension hook; a narrower flag is consistent with that direction and could be a reasonable contribution. But it doesn't address the deeper coupling concerns (release cadence, config shape, MCP transport spec drift). Acceptable as a hedge — an issue could be filed in parallel without blocking the fork.

### (c) Just rewrite the README, keep the wrapper

Most of the "identity coherence" and "coherent docs" benefits are documentation work, not architecture. Lead the README with schema-aware authoring; treat the upstream wrapper as an implementation detail (the way most plugins treat their dependencies). **Verdict: insufficient.** Solves the docs problem but not the technical ones — every upstream patch release can still surface a new override target, the `mcpPlugin` config shape stays leaky, and protocol-level changes (SSE, streaming) are still on upstream's cadence. Worth doing regardless as part of v0.4 launch.

## What needs to be reimplemented

Rough scope estimate: 1–2 days of focused work, plus tests. Each item is small.

- **HTTP endpoint** — register `/api/mcp` POST handler in `config.endpoints`. Use `@modelcontextprotocol/sdk` server primitives + the `mcp-handler` package (which is what the official plugin uses too). No Payload-specific complexity.
- **API key collection** — clone the official plugin's `payload-mcp-api-keys` collection config (~150 lines, mostly admin field metadata + the SHA-256 hash strategy). Or skip it entirely and use Payload's standard auth — API keys for any auth-enabled user collection already exist.
- **Bearer auth** — extract the API key from `Authorization: Bearer <key>`, hash + lookup, populate `req.user` from the linked user. ~30 lines.
- **Tool / prompt / resource registry** — already done in toolkit. Just point the new endpoint at it.
- **Per-collection / per-global `find` / `delete` enable flags** — already done in toolkit's `generateMcpCollectionConfigs`. Adapt to register `find<Resource>` and `delete<Resource>` tools directly instead of delegating.
- **`find<Resource>` / `delete<Resource>` tools** — the only official-plugin tools we'd actually port. `find` is a wrapper around `payload.find()`; `delete` is already half-replaced by the toolkit's `safeDelete` (we could keep both, or make `safeDelete` the only delete path).
- **Globals `find<Global>`** — wrapper around `payload.findGlobal()`. Handful of lines.
- **Migration path** — for existing toolkit users, the `payload-mcp-api-keys` collection slug should be preserved or aliased so existing keys keep working without DB migrations.

What we do NOT need to reimplement:
- The whole `convertCollectionSchemaToZod` pipeline (we don't use it).
- The `create<Resource>` / `update<Resource>` / `update<Global>` per-collection tools (replaced).
- Most of the experimental config surface (auth tools, collection mod tools, etc. — we don't expose any of it).

## Security requirements

These must be specced before implementation, not discovered during the spike. Inheriting "SHA-256" from upstream is a starting point, not a complete specification.

### API-key storage

- **Hash strategy.** SHA-256 alone is a fast hash, not a KDF. If keys are server-generated UUID-format / cryptographically random (32+ bytes of entropy), HMAC-SHA-256 with a server-side pepper is sufficient and cheap. If keys are ever user-supplied or shorter, switch to Argon2id or bcrypt. **Decision required before v0.4:** which key format do we generate? The format determines the hash choice.
- **Persistence.** The DB column stores the hash only; the raw key is never persisted.
- **Disclosure.** The raw key is shown exactly once on creation (admin UI + creation response). Subsequent reads of the row return only the hash. Payload's request logger and any custom logging hook must strip the `Authorization` header and the creation-response body before emission.
- **Comparison.** Lookup uses a constant-time comparison (e.g., Node's `crypto.timingSafeEqual`) — never `===` on strings — to prevent timing-oracle attacks against the stored hash.
- **Salt.** Each row has a per-row random salt mixed into the hash, so a DB breach doesn't enable rainbow-table attacks against shared key patterns.

### HTTP transport

- **Origin / Host validation.** The `/api/mcp` endpoint must reject requests whose `Origin` (when present) is not in an explicit allowlist, and reject requests whose `Host` header doesn't match the configured Payload public host. This blocks DNS-rebinding attacks against local Payload instances.
- **CORS.** Default to no CORS exposure (server-to-server only). If a browser-based MCP client is a use case, expose an explicit `allowedOrigins` config option — never `*`.
- **Method registration.** Register both POST and GET. POST is the spec method; GET returns a JSON-RPC error (clients that probe with GET get a useful error, not a 404). Mirrors upstream behavior.

### Per-API-key authorization model

The standalone version must commit to one of two models before v0.4:

- **Flat (any valid key = full access).** Simpler. Equivalent to current behavior. Document it as the v0.4 baseline. Single compromised key = full read/write/delete blast radius across all exposed collections; mitigation is operational (rotate keys frequently, never share, store in secret managers).
- **Scoped (per-key per-tool / per-collection enable flags).** Mirrors upstream's `mcpAccessSettings` shape (the API-key row carries a per-tool enable map). More work, but enables the "give my AI assistant a read-only key" pattern. Required before any "external client uses this key" use case becomes mainstream.

**Recommendation:** ship v0.4 with the flat model behind a clearly labeled "v0.4 limitation: keys are full-access" note in the README, and add scoped keys in v0.5. Avoids blocking the standalone migration on UI work.

### Audit logging

The standalone implementation owns the full request path for the first time. Without structured logging, post-incident forensics are impossible.

- **Per-call log entry.** Each MCP `tools/call` invocation records: API-key ID (not raw key), tool name, sanitized arg summary (truncate large `data` strings; never log full document bodies on creates/updates), success/failure, duration, request ID. Failures include the error class.
- **Auth failures.** Failed bearer-auth attempts log the attempted key prefix (first 8 chars) + IP + timestamp. Sufficient for credential-stuffing detection without storing full guesses.
- **Storage.** Use Payload's existing logger (`req.payload.logger`) so logs flow through the host's existing aggregation. Don't roll a new transport.
- **Rate limiting.** Out of scope for v0.4 if keys are high-entropy server-generated. Revisit if scoped keys ship in v0.5.

## Risks / open questions to think about

These are the places where this could turn into more than a 1–2 day job, or where we'd lock ourselves into a worse position. Grouped by category for scannability.

### A. Dependency & timing risks

**A-1. What does Payload's MCP plugin gain in the next 6 months?** If the upstream team is actively rewriting the authoring path (e.g. abandoning `json-schema-to-zod` in favor of a Payload-aware converter, or switching to a local-API approach themselves), waiting could be cheaper than forking.

*Research outcome (2026-05-04):* No rewrite signal. v3.82.x still uses `convertCollectionSchemaToZod` + `new Function()`. Issue #14942 (union-type fields in update) had a closed-without-merge PR. v3.83's extension hook for external custom tools signals upstream expects plugin authors to work around the built-ins, not that they intend to fix them. **Decision: proceed with fork.**

*Falsification rule (for re-evaluation cycles):* if at any point in the future upstream has any open PR or issue acknowledging the json-schema-to-zod problem with a maintainer comment in the last 90 days, defer further fork investment by a release cycle and re-evaluate. The asymmetric reversal cost (sunk fork vs. one more wrapper patch) favors deferring on weak signals.

**A-2. MCP transport future.** Right now everything is HTTP POST. The MCP spec is moving toward SSE / streaming. The official plugin will track that for us. Standalone, we'd need to track it ourselves — non-trivial if we want long-running tool calls or streaming responses. The `mcp-handler` dep we'd adopt has SSE support gated on a Redis env-var contract (`REDIS_URL` / `KV_URL`); we inherit that surface even though we'd ship with `disableSse: true` initially.

### B. Migration & backwards compatibility

**B-1. API key collection backwards compatibility.** Existing toolkit users have `payload-mcp-api-keys` rows in their DBs. If the standalone version uses a different slug, they lose all keys on upgrade. Keeping the same slug means we inherit a collection schema decision we didn't make — including upstream's dynamic field-tree generation (315 LOC tied to registered collections/globals/tools). Bit-for-bit field compatibility is required for zero-touch upgrade. Renaming with a migration is cleaner but adds upgrade friction.

**B-2. Plugin-conflict detection.** During a transitional install where both `@payloadcms/plugin-mcp` and the standalone toolkit are listed in `plugins[]`, two plugins try to register the same `payload-mcp-api-keys` slug → Payload boot crash. The standalone plugin must detect this on init and throw a helpful error directing the user to remove the old plugin first.

**B-3. Authorization model declarative surface.** The official plugin's per-tool / per-collection enable flags live on the API-key row and are surfaced by the admin UI. If we replace them with code-side flags, admins lose the ability to disable specific tools per-key without a deploy. The flat-vs-scoped decision under Security Requirements determines whether we keep this surface.

### C. Technical feasibility

**C-1. `find<Resource>` is converter-free upstream.** Reading `tools/resource/find.js` and `tools/schemas.js`, the official `find<Resource>` does NOT use `convertCollectionSchemaToZod` — its input schema is static Zod (`where`/`select`/`sort` are JSON-string fields). So `find` is *not* part of the same crash class as create/update; reimplementing it is a perf/simplification win (we drop `configToJSONSchema`'s per-request cost), not a parity-risk port. The Day-0 audit against `findPages` is still useful for behavioral confidence on complex `where` clauses, but it doesn't gate the scope decision.

**C-2. Naming / positioning.** `payload-mcp-toolkit` reads as "an add-on" to anyone scanning npm — which is currently accurate. After standalone, that framing becomes a slight misnomer ("toolkit" implies a layer atop something), but the cost of renaming an OSS package with existing adoption (npm discovery reset, GitHub stars anchored, installation friction for current users) outweighs the framing gain. **Decision: keep the `payload-mcp-toolkit` name through v0.4 and beyond.** Lead with the standalone story in the README; let the name be a historical artifact.

## Suggested next steps for when you pick this up

- **Day 0 — research (1 hr).** Skim Payload monorepo for plugin-mcp PRs/RFCs in flight. Confirm or disprove that upstream is iterating on the authoring path. *(Status as of 2026-05-04: complete. No rewrite in flight. See A-1.)*
- **Day 1 — spike.** Build a minimal standalone version against a fresh Payload project (no production users) — just `/api/mcp` + bearer auth + 1 tool registration. Confirm the transport / auth scaffolding is as small as estimated. Validate the global `Request`/`Response` clobber-guard pattern (see upstream `endpoints/mcp.js:42-66`) works in our integration.
- **Day 2 — decide.** If the spike came in within budget and there's no upstream rewrite incoming, port the toolkit's existing tools onto it and ship 0.4.0 as the first standalone release. If either of those turned out worse than expected, stay on the wrapper approach and write up the audit findings as a learning doc instead.

## Future work

Items considered but explicitly out of scope for the standalone v0.4 release have been moved to a separate doc with cost estimates: see `docs/brainstorms/standalone-plugin-future-work-2026-05-04.md`.

## Post-implementation learnings

- [docs/solutions/security-issues/mcp-auth-bypass-and-scope-fail-open-2026-05-05.md](../solutions/security-issues/mcp-auth-bypass-and-scope-fail-open-2026-05-05.md) — the scoped-authz model sketched in B-2 above shipped fail-open in v0.4.0 (custom endpoint did not gate on missing API-key context; `scopes.collections` fell through rather than whitelisting). Both issues fixed before release; the learning captures the corrected pattern.
