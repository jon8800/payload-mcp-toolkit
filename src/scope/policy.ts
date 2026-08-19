import type { CollectionAction, GlobalAction, KeyScopes, ScopePreset } from '../types'

// ─── Routing primitives ──────────────────────────────────────────────

export type ResourceKind = 'collection' | 'global' | 'account'

/**
 * Discriminated routing tag attached to every tool factory output.
 *
 * Collocates the scope-routing decision with the tool definition itself —
 * the registry derives the collection/global/account lookups from `tools`
 * at boot. Adding a new tool can no longer drift the routing maps out of
 * sync because TS requires `routing` on every factory return.
 */
export type ToolRouting =
  | { kind: 'collection'; action: CollectionAction }
  | { kind: 'global'; action: GlobalAction }
  | { kind: 'account'; action: CollectionAction }

/**
 * Minimal "routable tool" interface used by the policy module. The full
 * `ToolFactoryOutput` shape (handler, parameters, description) is irrelevant
 * here; we only need `name` + `routing` to build the lookup tables.
 */
export interface RoutableTool {
  name: string
  routing: ToolRouting
}

// ─── Per-preset action tables ────────────────────────────────────────

const ALL_ACTIONS: CollectionAction[] = ['read', 'create', 'update', 'delete']

export const PRESET_ACTIONS: Record<ScopePreset, CollectionAction[]> = {
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
export const PRESET_GLOBAL_ACTIONS: Record<ScopePreset, GlobalAction[]> = {
  'read-only': ['read'],
  editor: ['read'],
  admin: ['read', 'update'],
}

export const PRESET_TOOL_DENY: Record<ScopePreset, string[]> = {
  'read-only': [],
  editor: ['safeDelete', 'deleteDocument'],
  admin: [],
}

// ─── Routing tables built from the tool list ─────────────────────────

export interface ScopeDecision {
  allowed: boolean
  reason?: string
}

export interface RoutingTables {
  collectionToolAction: ReadonlyMap<string, CollectionAction>
  globalToolAction: ReadonlyMap<string, GlobalAction>
  accountToolAction: ReadonlyMap<string, CollectionAction>
  toolKind: ReadonlyMap<string, ResourceKind>
}

export function buildRoutingTables(tools: RoutableTool[]): RoutingTables {
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

// ─── Scope evaluation ────────────────────────────────────────────────

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
export function buildScopeChecker(tools: RoutableTool[]): ScopeChecker {
  const tables = buildRoutingTables(tools)
  return (scopes, toolName, resource) => assertScopeAllows(scopes, toolName, resource, tables)
}

/**
 * Internal pure checker. Exposed for the per-request wrapper in the registry
 * so it can re-use the same `RoutingTables` it built once at startup.
 */
export function assertScopeAllows(
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
    // Fail-closed. Every built-in collection/global tool takes a required
    // `collection` / `slug` argument, so this only fires for a malformed call
    // or for a host tool that declared resource routing without a resource
    // argument. Allowing it would let such a tool read a hard-coded collection
    // straight past the key's whitelist. A tool that genuinely spans the whole
    // install belongs on `routing.kind: 'account'`.
    return {
      allowed: false,
      reason:
        `Tool "${toolName}" is routed to a ${policy.label} but the call carries no ` +
        `${policy.label} argument, so its scope cannot be checked. A tool with a fixed ` +
        `or install-wide target must use routing.kind: 'account'.`,
    }
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

  // Explicit resource override is the tightest signal: an account-level tool
  // operates across the whole site (searchContent across every collection,
  // uploadMedia into any media coll, etc.) and would broaden the key beyond
  // the resource whitelist regardless of which preset is set. Deny account
  // tools whenever the key carries explicit collection/global scopes.
  if (scopes.collections || scopes.globals) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is denied for keys with explicit collection or global scopes — account-level tools would broaden access beyond the whitelist.`,
    }
  }

  if (presetActions) {
    if (action && !presetActions.includes(action)) {
      return {
        allowed: false,
        reason: `Action "${action}" is not permitted by this API key's preset.`,
      }
    }
    return { allowed: true }
  }

  return { allowed: true }
}
