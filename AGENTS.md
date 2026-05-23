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

## Cross-platform

Windows-host development is supported. Use PowerShell-compatible commands when shelling out; prefer the platform's Read/Edit/Glob/Grep tools over `cat`/`find`/`grep`.
