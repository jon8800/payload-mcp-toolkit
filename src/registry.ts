import type { PayloadRequest } from 'payload'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z, ZodObject, type ZodTypeAny } from 'zod'
import { getApiKeyContext } from './auth-strategy'
import type { CollectionAction, GlobalAction, KeyScopes, ScopePreset } from './types'

export type ResourceKind = 'collection' | 'global' | 'account'
import type { InitializeServerForRequest } from './endpoint'
import { stampMcpContext, type McpTextResponse } from './tools/_helpers'

// ─── Tool / Prompt / Resource shapes ──────────────────────────────────

/**
 * Discriminated routing tag attached to every tool factory output.
 *
 * Collocates the scope-routing decision with the tool definition itself —
 * the registry derives `TOOL_TO_ACTION` / `TOOL_TO_GLOBAL_ACTION` /
 * `ACCOUNT_LEVEL_ACTIONS` lookups from `tools` at boot. Adding a new tool
 * can no longer drift the routing maps out of sync because TS requires
 * `routing` on every factory return.
 */
export type ToolRouting =
  | { kind: 'collection'; action: CollectionAction }
  | { kind: 'global'; action: GlobalAction }
  | { kind: 'account'; action: CollectionAction }

export interface ToolFactoryOutput {
  name: string
  description: string
  /**
   * Either a raw Zod shape (`{ key: ZodType }`) or a `z.object({...})`
   * instance. The registry normalises both before registering with the SDK.
   */
  parameters: Record<string, ZodTypeAny> | ZodObject<Record<string, ZodTypeAny>>
  handler: (
    args: Record<string, unknown>,
    req: PayloadRequest,
    extra: unknown,
  ) => Promise<McpTextResponse> | McpTextResponse
  routing: ToolRouting
}

/**
 * Returns the raw `{ name: ZodType }` shape for either a raw shape or a
 * `z.object({...})` instance. The MCP SDK's `registerTool` expects the raw
 * shape under `inputSchema`; passing a ZodObject silently registers an
 * empty schema and breaks args validation.
 */
function toZodShape(
  parameters: Record<string, ZodTypeAny> | ZodObject<Record<string, ZodTypeAny>>,
): Record<string, ZodTypeAny> {
  if (parameters instanceof ZodObject) {
    return parameters.shape as Record<string, ZodTypeAny>
  }
  return parameters
}

export interface PromptFactoryOutput {
  name: string
  title?: string
  description?: string
  argsSchema?: Record<string, ZodTypeAny>
  handler: (args: unknown, req: PayloadRequest, extra: unknown) => unknown
}

export interface ResourceFactoryOutput {
  name: string
  uri: string
  title?: string
  description?: string
  mimeType?: string
  handler: (args: unknown, req: PayloadRequest, extra: unknown) => unknown
}

// ─── Scope evaluation ────────────────────────────────────────────────

const ALL_ACTIONS: CollectionAction[] = ['read', 'create', 'update', 'delete']

const PRESET_ACTIONS: Record<ScopePreset, CollectionAction[]> = {
  'read-only': ['read'],
  editor: ['read', 'create', 'update'],
  admin: ALL_ACTIONS,
}

/**
 * Asymmetric per-preset action map for globals. `editor` is intentionally
 * read-only on globals — a single bad write on a singleton broadcasts
 * site-wide with no per-document containment. Operators who want global
 * writes promote the key to `admin` or use a Custom key with explicit
 * `globalScopes`. README and CHANGELOG call out the asymmetry.
 */
const PRESET_GLOBAL_ACTIONS: Record<ScopePreset, GlobalAction[]> = {
  'read-only': ['read'],
  editor: ['read'],
  admin: ['read', 'update'],
}

const PRESET_TOOL_DENY: Record<ScopePreset, string[]> = {
  'read-only': [],
  editor: ['safeDelete', 'deleteDocument'],
  admin: [],
}

export interface ScopeDecision {
  allowed: boolean
  reason?: string
}

/**
 * Routing tables built from the tool list at initializer construction. Each
 * factory carries its own `routing` discriminator (see `ToolRouting`), so
 * the mapping cannot drift out of sync with the tool list — adding a tool
 * without routing is a TS error at the factory return site.
 *
 * The boot-time `assertScopeRegistryInvariant` previously guarded the
 * "forgot to wire a new tool into the routing map" failure mode. That
 * failure is now structurally unrepresentable.
 */
interface RoutingTables {
  collectionToolAction: ReadonlyMap<string, CollectionAction>
  globalToolAction: ReadonlyMap<string, GlobalAction>
  accountToolAction: ReadonlyMap<string, CollectionAction>
  toolKind: ReadonlyMap<string, ResourceKind>
}

function buildRoutingTables(tools: ToolFactoryOutput[]): RoutingTables {
  const collectionToolAction = new Map<string, CollectionAction>()
  const globalToolAction = new Map<string, GlobalAction>()
  const accountToolAction = new Map<string, CollectionAction>()
  const toolKind = new Map<string, ResourceKind>()
  for (const t of tools) {
    toolKind.set(t.name, t.routing.kind)
    if (t.routing.kind === 'collection') collectionToolAction.set(t.name, t.routing.action)
    else if (t.routing.kind === 'global') globalToolAction.set(t.name, t.routing.action)
    else accountToolAction.set(t.name, t.routing.action)
  }
  return { collectionToolAction, globalToolAction, accountToolAction, toolKind }
}

export type ScopeChecker = (
  scopes: KeyScopes | null | undefined,
  toolName: string,
  resource: string | undefined,
) => ScopeDecision

/**
 * Build a scope checker bound to a concrete tool list. The checker is a pure
 * function over (scopes, toolName, resource) — the routing tables are closed
 * over once at construction time.
 *
 * Fail-closed semantics:
 *   - Null/undefined scopes grant full access (back-compat).
 *   - When `scopes.collections` / `scopes.globals` is set, it is a *whitelist*
 *     for that resource kind — unlisted resources are denied.
 *   - When a tool resolves to a collection or global kind but the corresponding
 *     scope map is undefined and `scopes.preset` is undefined, the call is
 *     denied (closes the `tools.allow`-only latent fail-open).
 *   - Account-level tools are gated by the preset's action list, if a preset
 *     is set. Without a preset, a key scoped to specific collections/globals
 *     cannot use account-level tools — they'd broaden the surface.
 */
export function buildScopeChecker(tools: ToolFactoryOutput[]): ScopeChecker {
  const tables = buildRoutingTables(tools)
  return (scopes, toolName, resource) => assertScopeAllowsImpl(scopes, toolName, resource, tables)
}

function assertScopeAllowsImpl(
  scopes: KeyScopes | null | undefined,
  toolName: string,
  resource: string | undefined,
  tables: RoutingTables,
): ScopeDecision {
  const resourceKind = tables.toolKind.get(toolName) ?? null
  // Unregistered tool — fail-closed at request time. Adding a tool without a
  // routing field is a TS error at the factory return site, so this branch
  // only fires for typo'd tool names sent by the client.
  if (resourceKind === null) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" has no registered scope mapping.`,
    }
  }

  if (!scopes || (scopes.preset === undefined && !scopes.collections && !scopes.globals && !scopes.tools)) {
    return { allowed: true }
  }

  if (scopes.tools?.deny?.includes(toolName)) {
    return { allowed: false, reason: `Tool "${toolName}" is denied for this API key.` }
  }
  if (scopes.tools?.allow && !scopes.tools.allow.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is not in the allow-list for this API key.`,
    }
  }

  if (scopes.preset && PRESET_TOOL_DENY[scopes.preset]?.includes(toolName)) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is not allowed by the "${scopes.preset}" preset.`,
    }
  }

  if (resourceKind === 'account') {
    return checkAccount(scopes, toolName, tables.accountToolAction)
  }
  const policy = resourceKind === 'collection' ? COLLECTION_POLICY : GLOBAL_POLICY
  const toolAction =
    resourceKind === 'collection' ? tables.collectionToolAction : tables.globalToolAction
  return checkResource(scopes, toolName, resource, toolAction, policy)
}

/**
 * Per-resource-kind policy. Collapses what used to be two near-identical
 * `checkCollection` / `checkGlobal` helpers — the only differences are
 * the preset-actions table, the label, and which axis of `KeyScopes` to
 * read for explicit overrides.
 */
interface ResourcePolicy {
  presetActions: Record<ScopePreset, readonly string[]>
  scopeAxis: 'collections' | 'globals'
  label: 'collection' | 'global'
  Label: 'Collection' | 'Global'
}

const COLLECTION_POLICY: ResourcePolicy = {
  presetActions: PRESET_ACTIONS,
  scopeAxis: 'collections',
  label: 'collection',
  Label: 'Collection',
}

const GLOBAL_POLICY: ResourcePolicy = {
  presetActions: PRESET_GLOBAL_ACTIONS,
  scopeAxis: 'globals',
  label: 'global',
  Label: 'Global',
}

function checkResource(
  scopes: KeyScopes,
  toolName: string,
  resource: string | undefined,
  toolAction: ReadonlyMap<string, string>,
  policy: ResourcePolicy,
): ScopeDecision {
  const action = toolAction.get(toolName)
  const presetActions = scopes.preset ? policy.presetActions[scopes.preset] : undefined
  const resourceScope = scopes[policy.scopeAxis]

  if (!resource) {
    // Resource-keyed tool called without a slug; defer to schema validation.
    return { allowed: true }
  }
  if (!action) return { allowed: true }

  if (resourceScope) {
    const override = resourceScope[resource]
    if (!override) {
      return {
        allowed: false,
        reason: `${policy.Label} "${resource}" is not in this API key's allowed ${policy.scopeAxis}.`,
      }
    }
    if (!override.includes(action as never)) {
      return {
        allowed: false,
        reason: `Action "${action}" on ${policy.label} "${resource}" is not permitted by this API key's scope.`,
      }
    }
    return { allowed: true }
  }

  if (!presetActions) {
    // Fail-closed: `tools.allow` without a resource map or preset would
    // otherwise broadcast the tool across every resource. Require explicit
    // intent.
    return {
      allowed: false,
      reason: `Tool "${toolName}" requires an explicit ${policy.label} scope or preset on this API key.`,
    }
  }

  if (!presetActions.includes(action)) {
    return {
      allowed: false,
      reason: `Action "${action}" on ${policy.label} "${resource}" is not permitted by this API key's preset.`,
    }
  }
  return { allowed: true }
}

function checkAccount(
  scopes: KeyScopes,
  toolName: string,
  toolAction: ReadonlyMap<string, CollectionAction>,
): ScopeDecision {
  const action = toolAction.get(toolName)
  const presetActions = scopes.preset ? PRESET_ACTIONS[scopes.preset] : undefined

  if (presetActions) {
    if (action && !presetActions.includes(action)) {
      return {
        allowed: false,
        reason: `Action "${action}" is not permitted by this API key's preset.`,
      }
    }
    return { allowed: true }
  }

  // No preset but a resource-scoped key exists (collections or globals) →
  // account-level tools broaden the surface beyond the scoped resources.
  if (scopes.collections || scopes.globals) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" requires a resource argument under this API key's scoped configuration.`,
    }
  }

  return { allowed: true }
}

// ─── Audit logging helpers ───────────────────────────────────────────

const MAX_LOGGED_STRING = 200

/**
 * Returns the top-level keys of a JSON-string `data` arg, sanitized.
 * Per the Codex post-planning finding: logging key names (not values) lets us
 * later analyze whether the prose-only input shape is causing AI mistakes.
 */
function extractDataKeys(args: Record<string, unknown>): string[] | undefined {
  const data = args.data
  if (typeof data !== 'string') return undefined
  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>)
    }
  } catch {
    return undefined
  }
  return undefined
}

function summariseArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > MAX_LOGGED_STRING) {
      out[k] = `<truncated:${v.length}>`
    } else {
      out[k] = v
    }
  }
  return out
}

function getRequestId(req: PayloadRequest): string | undefined {
  const headers = req.headers as Headers | undefined
  return headers?.get?.('x-request-id') ?? undefined
}

// ─── Initializer factory ─────────────────────────────────────────────

export interface CreateInitializeServerOptions {
  tools: ToolFactoryOutput[]
  prompts?: PromptFactoryOutput[]
  resources?: ResourceFactoryOutput[]
}

interface ScopeRejectionResult {
  content: Array<{ type: 'text'; text: string }>
  isError: true
}

function scopeRejectionResult(reason: string): ScopeRejectionResult {
  return {
    content: [{ type: 'text', text: `Scope rejection: ${reason}` }],
    isError: true,
  }
}

/**
 * Builds the per-request initializer. mcp-handler invokes this once per
 * `tools/call` / `tools/list` JSON-RPC request, passing a fresh McpServer.
 *
 * Each tool handler is wrapped to:
 *   1. Read the API-key context populated by the bearer auth strategy.
 *   2. Reject the call (as an `isError: true` result, not a JSON-RPC error)
 *      when scopes deny it — per the MCP spec, tool-execution failures
 *      surface in the result envelope so the LLM can self-correct.
 *   3. Stamp `req.context.source = 'mcp'` for downstream hooks.
 *   4. Emit a structured audit log entry on every success / failure.
 */
export function createInitializeServer(
  options: CreateInitializeServerOptions,
): InitializeServerForRequest {
  const { tools, prompts = [], resources = [] } = options
  const tables = buildRoutingTables(tools)

  return (req: PayloadRequest) => (server: McpServer) => {
    const logger = req.payload?.logger
    const requestId = getRequestId(req)

    for (const tool of tools) {
      const resourceKind = tables.toolKind.get(tool.name) ?? null
      const wrapped = async (
        args: Record<string, unknown>,
        extra: unknown,
      ): Promise<unknown> => {
        const start = Date.now()
        const keyCtx = getApiKeyContext(req)
        const targetSlug =
          typeof args.collection === 'string'
            ? args.collection
            : typeof args.slug === 'string'
              ? args.slug
              : undefined
        const targetKind = resourceKind ?? undefined
        const dataKeys = extractDataKeys(args)

        const decision = assertScopeAllowsImpl(
          keyCtx?.scopes ?? null,
          tool.name,
          targetSlug,
          tables,
        )
        // Audit-log writes must never break the tool dispatch path. A
        // throwing logger transport (closed stream during HMR, custom pino
        // dest) would otherwise flip a success to isError or mask the real
        // tool error. Swallow logger exceptions here.
        const safeLog = (
          level: 'info' | 'warn' | 'error',
          payload: Record<string, unknown>,
          message: string,
        ) => {
          try {
            logger?.[level]?.(payload, message)
          } catch {
            // Logger transport failure must not break dispatch.
          }
        }

        if (!decision.allowed) {
          safeLog(
            'warn',
            {
              event: 'mcp.tool_call',
              keyId: keyCtx?.keyId,
              keyPrefix: keyCtx?.keyPrefix,
              tool: tool.name,
              targetSlug,
              targetKind,
              dataKeys,
              success: false,
              isError: true,
              durationMs: Date.now() - start,
              requestId,
              errorClass: 'ScopeRejection',
            },
            `[payload-mcp-toolkit] Scope-rejected tool call: ${tool.name}`,
          )
          return scopeRejectionResult(decision.reason ?? 'denied')
        }

        stampMcpContext(req)

        try {
          const result = await tool.handler(args, req, extra)
          safeLog(
            'info',
            {
              event: 'mcp.tool_call',
              keyId: keyCtx?.keyId,
              keyPrefix: keyCtx?.keyPrefix,
              tool: tool.name,
              targetSlug,
              targetKind,
              dataKeys,
              success: true,
              isError: false,
              durationMs: Date.now() - start,
              requestId,
            },
            `[payload-mcp-toolkit] Tool call: ${tool.name}`,
          )
          return result
        } catch (err) {
          const errorClass = err instanceof Error ? err.name : 'UnknownError'
          const message = err instanceof Error ? err.message : String(err)
          safeLog(
            'error',
            {
              event: 'mcp.tool_call',
              err,
              keyId: keyCtx?.keyId,
              keyPrefix: keyCtx?.keyPrefix,
              tool: tool.name,
              targetSlug,
              targetKind,
              dataKeys,
              argsSummary: summariseArgs(args),
              success: false,
              isError: true,
              durationMs: Date.now() - start,
              requestId,
              errorClass,
            },
            `[payload-mcp-toolkit] Tool call failed: ${tool.name}`,
          )
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
          }
        }
      }

      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: toZodShape(tool.parameters),
        },
        wrapped as never,
      )
    }

    for (const prompt of prompts) {
      const wrapped = async (args: unknown, extra: unknown) => {
        try {
          return await prompt.handler(args, req, extra)
        } catch (err) {
          logger?.error?.(
            { event: 'mcp.prompt', err, prompt: prompt.name, requestId },
            `[payload-mcp-toolkit] Prompt failed: ${prompt.name}`,
          )
          throw err
        }
      }
      server.registerPrompt(
        prompt.name,
        {
          title: prompt.title,
          description: prompt.description,
          argsSchema: prompt.argsSchema as never,
        },
        wrapped as never,
      )
    }

    for (const resource of resources) {
      const wrapped = async (args: unknown, extra: unknown) => {
        try {
          return await resource.handler(args, req, extra)
        } catch (err) {
          logger?.error?.(
            { event: 'mcp.resource', err, resource: resource.name, requestId },
            `[payload-mcp-toolkit] Resource read failed: ${resource.name}`,
          )
          throw err
        }
      }
      server.registerResource(
        resource.name,
        resource.uri as never,
        {
          title: resource.title,
          description: resource.description,
          mimeType: resource.mimeType,
        },
        wrapped as never,
      )
    }
  }
}

// Helper retained for symmetry / explicit imports. Acts as a sanity check
// that downstream callers see a consistent z reference.
export const zodRefForDeps: typeof z = z
