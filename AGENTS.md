# AGENTS.md — payload-mcp-toolkit

Working notes for AI coding agents (Claude Code, Codex, Cursor, etc.) operating in this repo.

## Project orientation

- **What this is:** standalone Payload CMS v3 plugin. Owns `/api/mcp`, the `payload-mcp-api-keys` collection, the bearer auth strategy, scope-evaluation policy, draft workflow, and the AI-facing tool/prompt/resource surface. The plugin entry point is `src/index.ts` → `mcpToolkitPlugin`.
- **Language / build:** TypeScript, ESM. Types via `tsc -p tsconfig.build.json`; JS emit via `swc`. Tests run on `vitest`.
- **Package manager:** `pnpm`.

## Repository layout (high signal only)

```
src/
  index.ts                  # plugin entry; wires tools/resources/endpoints
  endpoint.ts               # POST/GET /mcp; gates bearer auth before dispatch
  auth-strategy.ts          # Payload auth.strategies entry; composeScopes
  api-keys.ts               # payload-mcp-api-keys collection definition
  registry.ts               # tool/resource/prompt registration with mcp-handler
  scope/
    policy.ts               # assertScopeAllows; checkResource; checkAccount; ToolRouting
    audit-log.ts            # safe audit logger + targetKind shape
  tools/                    # one file per MCP tool factory (find*, update*, patch*, etc.)
  components/               # admin client components (scope matrices)
  __tests__/                # vitest unit + integration suites
docs/
  solutions/                # documented solutions — see "Documented solutions" below
  plans/                    # historical implementation plans
  brainstorms/              # historical brainstorms
dev/                        # Payload dev app used for local plugin development
```

## Documented solutions

`docs/solutions/` — past problems and decisions documented as learnings, organized by category (`security-issues/`, `architecture-patterns/`, etc.) with YAML frontmatter (`module`, `tags`, `problem_type`, `component`, `severity`). Covers bugs, best practices, workflow patterns, and architectural decisions. Relevant when implementing or debugging in documented areas — especially auth, scope policy, globals, block nesting, draft workflow, and the plugin entry point. New learnings land here via `/ce-compound`; refresh via `/ce-compound-refresh`.

## Conventions specific to this repo

- **Scope evaluator is fail-closed.** Every branch in `src/scope/policy.ts` ends in an explicit `{ allowed: true }` or `{ allowed: false, reason }`. No `if (x && …)` patterns where `undefined` silently allows. New tools declare `routing: { kind: 'collection' | 'global' | 'account'; action: '…' } as const` on their factory return — the discriminated union is the single source of truth for routing.
- **Local dev uses `push: true`.** Do not run `payload migrate` against the local dev database — Drizzle auto-syncs on `pnpm dev`. Production migrations only.
- **Tests must pass before commit.** `npx vitest run` is the canonical gate. Type-check via `npx tsc -p tsconfig.build.json --noEmit`.
- **No comments unless the WHY is non-obvious.** Match the existing style.
- **Don't run `pnpm dev` / `pnpm build` / `pnpm test` unless asked.** The user runs these themselves.

## Test discipline

Past sessions shipped P0/P1 bugs that the existing tests + browser smoke tests didn't catch. The pattern: tests pinned the diff's new code path, not the documented contract; recovery branches landed without paired tests; preset × override interactions were tested one axis at a time. Rules below close those gaps — apply on every diff touching `auth-strategy.ts`, `api-keys.ts`, `scope/policy.ts`, or any tool's error/recovery branch.

1. **Every new `catch` / recovery branch lands with paired tests.** When a tool or hook adds an error-recovery path, the same diff must add tests exercising (a) the recovery firing on the expected error shape, (b) the recovery NOT firing on edge cases that look similar but are not the same condition (e.g. a stale pre-existing state vs the current attempt landing), and (c) the fall-through when the recovery's own read / probe fails. Reviewer rejects a diff that adds a catch branch with no corresponding test. Example: `__tests__/publish-draft.test.ts` covers six scenarios for the post-write validator recovery.
2. **`admin.description` text and runtime behaviour land in the same diff, with a contract test.** When you change a field's `admin.description` (or any documented user-visible contract string), the same diff must add or update a test that asserts the runtime branch matches what the description promises. When you change the runtime branch, the same diff must update the description. A test using a literal substring from the description is enough — e.g. asserting that "explicit empty list is treated as deny-all on this axis" still holds under the configurations the description claims to cover. Prevents the v0.7.1-class regression where the diff updated the hook + composeScopes but left the field description out of sync, with no CI signal.
3. **Scope semantics changes require a scenario-table test.** Any diff changing `composeScopes`, the `payload-mcp-api-keys` `beforeValidate` hook, or `src/scope/policy.ts` must add a table-driven test spanning the preset × override 2D space — not single-axis tests. Cover at minimum: `(preset ∈ {custom, admin, editor, read-only}) × (collectionScopes ∈ {null, [], [entry]}) × (globalScopes ∈ {null, [], [entry]}) × (toolAllow ∈ {null, [], [entry]}) × (toolDeny ∈ {null, [], [entry]})`. You do not need every cell; you do need the cells the change crosses. This is mandated by `docs/solutions/security-issues/scope-bypass-account-tools-and-globals-exclusion-leak.md`.
4. **Browser smoke tests are functional sign-off, not security / correctness coverage.** Smoke tests confirm the UI saves and the happy-path tool call returns. They do not reproduce post-write validator races, stale-version masking, hook-bypass paths (Local API with `disableHooks: true`, direct DB writes), or `originalDoc` fall-through edge cases. Auth, scope-policy, and tool error-recovery code must carry unit tests for those classes regardless of what the smoke test exercised.
5. **Property to enforce on every scope change: fail-closed AND on-write + on-read in sync.** The on-write counterpart (beforeValidate normalization in `api-keys.ts`) and the on-read counterpart (`composeScopes` in `auth-strategy.ts`) must agree on the per-axis empty-array rule. If one layer treats `[]` differently from the other, an upstream Payload change (default value timing, hook ordering, replication lag) can reintroduce the v0.7.0 deny-all-on-every-preset-key bug. Add the test on both sides, not just the layer you changed.

## Cross-platform

Windows-host development is supported. Use PowerShell-compatible commands when shelling out; prefer the platform's Read/Edit/Glob/Grep tools over `cat`/`find`/`grep`.
