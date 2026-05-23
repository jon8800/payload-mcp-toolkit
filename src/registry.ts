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

/** Collection-keyed tools: action depends on the targeted collection slug. */
export const TOOL_TO_ACTION: Record<string, CollectionAction> = {
  findDocument: 'read',
  listVersions: 'read',
  createDocument: 'create',
  updateDocument: 'update',
  patchLayout: 'update',
  publishDraft: 'update',
  schedulePublish: 'update',
  restoreVersion: 'update',
  deleteDocument: 'delete',
  safeDelete: 'delete',
}

/** Global-keyed tools: action depends on the targeted global slug. */
export const TOOL_TO_GLOBAL_ACTION: Record<string, GlobalAction> = {
  findGlobal: 'read',
  updateGlobal: 'update',
  patchGlobalLayout: 'update',
  publishGlobalDraft: 'update',
  listGlobalVersions: 'read',
  restoreGlobalVersion: 'update',
}

/**
 * Account-level tools: no resource scope; the preset's action list gates
 * them directly. The implied action is what the preset must permit
 * account-wide (e.g. `uploadMedia` requires `create`).
 */
export const ACCOUNT_LEVEL_ACTIONS: Record<string, CollectionAction> = {
  searchContent: 'read',
  resolveReference: 'read',
  uploadMedia: 'create',
}

export const ACCOUNT_LEVEL_TOOLS: ReadonlySet<string> = new Set(Object.keys(ACCOUNT_LEVEL_ACTIONS))

export interface ScopeDecision {
  allowed: boolean
  reason?: string
}

/**
 * Look up which routing set a tool belongs to. Returns `null` when the tool
 * isn't registered in any set — at request time that produces a fail-closed
 * denial; at boot time `assertScopeRegistryInvariant` turns it into a
 * startup error so the mistake surfaces before the first request.
 */
export function resolveResourceKind(toolName: string): ResourceKind | null {
  if (toolName in TOOL_TO_ACTION) return 'collection'
  if (toolName in TOOL_TO_GLOBAL_ACTION) return 'global'
  if (ACCOUNT_LEVEL_TOOLS.has(toolName)) return 'account'
  return null
}

/**
 * Plugin-init invariant: every registered tool name must appear in exactly
 * one of `TOOL_TO_ACTION`, `TOOL_TO_GLOBAL_ACTION`, or `ACCOUNT_LEVEL_TOOLS`.
 *
 * Membership prevents a "forgot to register" mistake from silently falling
 * through at request time. Disjointness prevents ambiguity between collection
 * and global routing for the same name.
 *
 * Called once from `src/index.ts` after the tool list is assembled. Throws
 * synchronously so plugin boot fails with an actionable message.
 */
export function assertScopeRegistryInvariant(toolNames: string[]): void {
  const missing: string[] = []
  const duplicates: string[] = []
  for (const name of toolNames) {
    let memberships = 0
    if (name in TOOL_TO_ACTION) memberships++
    if (name in TOOL_TO_GLOBAL_ACTION) memberships++
    if (ACCOUNT_LEVEL_TOOLS.has(name)) memberships++
    if (memberships === 0) missing.push(name)
    if (memberships > 1) duplicates.push(name)
  }
  if (missing.length > 0 || duplicates.length > 0) {
    const parts: string[] = ['[payload-mcp-toolkit] Scope routing invariant violated.']
    if (missing.length > 0) {
      parts.push(
        `Tool(s) absent from TOOL_TO_ACTION, TOOL_TO_GLOBAL_ACTION, and ACCOUNT_LEVEL_TOOLS: ${missing.join(', ')}.`,
      )
    }
    if (duplicates.length > 0) {
      parts.push(
        `Tool(s) registered in more than one routing set: ${duplicates.join(', ')}.`,
      )
    }
    parts.push('Add the tool to exactly one routing set in src/registry.ts.')
    throw new Error(parts.join(' '))
  }
}

/**
 * Pure function: decide whether a tool call is permitted given the request's
 * scopes, the tool's resource kind, and (when applicable) the targeted slug.
 *
 * Resource kind is derived by the caller via `resolveResourceKind(toolName)`
 * so per-call routing is explicit; we don't re-derive inside this function.
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
export function assertScopeAllows(
  scopes: KeyScopes | null | undefined,
  toolName: string,
  resource: string | undefined,
  resourceKind: ResourceKind | null = resolveResourceKind(toolName),
): ScopeDecision {
  // Unregistered tool — fail-closed at request time. The invariant check
  // catches this at boot, but this is the belt-and-braces fallback.
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

  if (resourceKind === 'collection') {
    return checkCollection(scopes, toolName, resource)
  }
  if (resourceKind === 'global') {
    return checkGlobal(scopes, toolName, resource)
  }
  return checkAccount(scopes, toolName)
}

function checkCollection(
  scopes: KeyScopes,
  toolName: string,
  collection: string | undefined,
): ScopeDecision {
  const action = TOOL_TO_ACTION[toolName]
  const presetActions = scopes.preset ? PRESET_ACTIONS[scopes.preset] : undefined
  const collectionsScope = scopes.collections

  if (!collection) {
    // Collection-keyed tool called without a slug; defer to schema validation.
    return { allowed: true }
  }
  if (!action) return { allowed: true }

  if (collectionsScope) {
    const override = collectionsScope[collection]
    if (!override) {
      return {
        allowed: false,
        reason: `Collection "${collection}" is not in this API key's allowed collections.`,
      }
    }
    if (!override.includes(action)) {
      return {
        allowed: false,
        reason: `Action "${action}" on collection "${collection}" is not permitted by this API key's scope.`,
      }
    }
    return { allowed: true }
  }

  if (!presetActions) {
    // Fail-closed: `tools.allow` without a `collections` map or preset would
    // otherwise broadcast the tool across every collection. Require explicit
    // intent.
    return {
      allowed: false,
      reason: `Tool "${toolName}" requires an explicit collection scope or preset on this API key.`,
    }
  }

  if (!presetActions.includes(action)) {
    return {
      allowed: false,
      reason: `Action "${action}" on collection "${collection}" is not permitted by this API key's preset.`,
    }
  }
  return { allowed: true }
}

function checkGlobal(
  scopes: KeyScopes,
  toolName: string,
  global: string | undefined,
): ScopeDecision {
  const action = TOOL_TO_GLOBAL_ACTION[toolName]
  const presetActions = scopes.preset ? PRESET_GLOBAL_ACTIONS[scopes.preset] : undefined
  const globalsScope = scopes.globals

  if (!global) {
    return { allowed: true }
  }
  if (!action) return { allowed: true }

  if (globalsScope) {
    const override = globalsScope[global]
    if (!override) {
      return {
        allowed: false,
        reason: `Global "${global}" is not in this API key's allowed globals.`,
      }
    }
    if (!override.includes(action)) {
      return {
        allowed: false,
        reason: `Action "${action}" on global "${global}" is not permitted by this API key's scope.`,
      }
    }
    return { allowed: true }
  }

  if (!presetActions) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" requires an explicit global scope or preset on this API key.`,
    }
  }

  if (!presetActions.includes(action)) {
    return {
      allowed: false,
      reason: `Action "${action}" on global "${global}" is not permitted by this API key's preset.`,
    }
  }
  return { allowed: true }
}

function checkAccount(scopes: KeyScopes, toolName: string): ScopeDecision {
  const action = ACCOUNT_LEVEL_ACTIONS[toolName]
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

  return (req: PayloadRequest) => (server: McpServer) => {
    const logger = req.payload?.logger
    const requestId = getRequestId(req)

    for (const tool of tools) {
      const resourceKind = resolveResourceKind(tool.name)
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

        const decision = assertScopeAllows(
          keyCtx?.scopes ?? null,
          tool.name,
          targetSlug,
          resourceKind,
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
