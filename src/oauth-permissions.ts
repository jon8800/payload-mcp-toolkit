// Pure helpers shared by the OAuth server (src/oauth.ts) and the consent screen
// (src/components/OAuthView.tsx). No Node or Payload runtime imports: the admin bundle loads this file.
import { PRESET_ACTIONS, PRESET_GLOBAL_ACTIONS, PRESET_TOOL_DENY, type ResourceKind } from './scope/policy'
import type { CollectionAction, GlobalAction, KeyScopes } from './types'

/** OAuth grants top out at editor: delete and global writes need an API key. */
export type Level = 'read-only' | 'editor'

export interface CatalogTool { name: string; kind: ResourceKind; action: CollectionAction }
/** What the consent screen can offer: exposed collections, globals and registered tools. */
export interface Catalog { collections: string[]; globals: string[]; tools: CatalogTool[] }

/**
 * What the consent form submits. An omitted list means "all of them" (the form sends only the lists
 * the user changed); anything outside the catalog or the level is dropped.
 */
export interface Choice {
  level?: Level
  collections?: Record<string, string[]>
  globals?: Record<string, string[]>
  tools?: string[]
}

export const collectionActions = (level: Level): CollectionAction[] => PRESET_ACTIONS[level]
export const globalActions = (level: Level): GlobalAction[] => PRESET_GLOBAL_ACTIONS[level]

/** Tools a grant at this level could ever run. The rest are hidden, not offered. */
export function toolsFor(catalog: Catalog, level: Level): CatalogTool[] {
  return catalog.tools.filter(t => !PRESET_TOOL_DENY[level].includes(t.name) &&
    (t.kind === 'global' ? globalActions(level) : collectionActions(level)).includes(t.action as never))
}

/** Full access at a level, in the shape the consent form submits. The consent screen's default. */
export function fullChoice(catalog: Catalog, level: Level): Required<Choice> {
  return {
    level,
    collections: Object.fromEntries(catalog.collections.map(slug => [slug, collectionActions(level)])),
    globals: Object.fromEntries(catalog.globals.map(slug => [slug, globalActions(level)])),
    tools: toolsFor(catalog, level).map(t => t.name),
  }
}

// A whitelist equal to "everything" is left out, so account-wide tools (search, upload) keep working
// and collections added later are included. The scope checker denies account tools once a whitelist is set.
function pick<A extends string>(slugs: string[], chosen: Record<string, string[]> | undefined, allowed: A[]): Record<string, A[]> | undefined {
  if (chosen === undefined) return undefined
  const map: Record<string, A[]> = {}
  let full = true
  for (const slug of slugs) {
    const picked = chosen && typeof chosen === 'object' && Object.hasOwn(chosen, slug) && Array.isArray(chosen[slug]) ? chosen[slug] : []
    const actions = allowed.filter(a => picked.includes(a))
    if (actions.length) map[slug] = actions
    if (actions.length !== allowed.length) full = false
  }
  return full ? undefined : map
}

/** Turns a submitted choice into the scopes stored on the grant, capped at `max`. */
export function permissionsFrom(choice: Choice, catalog: Catalog, max: Level): { level: Level; permissions: KeyScopes } {
  const level: Level = choice.level === 'editor' && max === 'editor' ? 'editor' : 'read-only'
  const offered = toolsFor(catalog, level).map(t => t.name)
  const tools = choice.tools === undefined ? offered : Array.isArray(choice.tools) ? offered.filter(name => choice.tools!.includes(name)) : []
  const collections = pick(catalog.collections, choice.collections, collectionActions(level))
  const globals = pick(catalog.globals, choice.globals, globalActions(level))
  return { level, permissions: {
    preset: level,
    ...(collections && { collections }),
    ...(globals && { globals }),
    ...(tools.length !== offered.length && { tools: { allow: tools } }),
  } }
}

/**
 * Re-caps a grant's stored scopes on every request. The site's access level or the token's scope may have
 * shrunk since consent, and the scope checker honours a collection/global list over the preset, so the
 * lists themselves must lose the actions the current level no longer allows.
 */
export function clampScopes(stored: KeyScopes, max: Level): KeyScopes {
  const level: Level = stored.preset === 'editor' && max === 'editor' ? 'editor' : 'read-only'
  const within = <A extends string>(map: Record<string, A[]>, allowed: A[]) =>
    Object.fromEntries(Object.entries(map).map(([slug, actions]) => [slug, actions.filter(a => allowed.includes(a))]))
  return {
    preset: level,
    ...(stored.collections && { collections: within(stored.collections, collectionActions(level)) }),
    ...(stored.globals && { globals: within(stored.globals, globalActions(level)) }),
    ...(stored.tools && { tools: stored.tools }),
  }
}

/** One line for the connections page, e.g. "Read, create and update · 3 of 12 collections · all tools". */
type Lists = { collections?: Record<string, unknown[]>; globals?: Record<string, unknown[]>; tools?: { allow?: string[] } }
export function summarize(permissions: Lists | undefined, level: Level, catalog: Catalog): string {
  const count = (map: Record<string, unknown[]> | undefined, total: number, noun: string) =>
    !map ? `all ${noun}` : `${Object.keys(map).length} of ${total} ${noun}`
  // Counts tools that will actually run: limited collections or globals switch account-wide tools off.
  const offered = toolsFor(catalog, level)
  const limited = Boolean(permissions?.collections || permissions?.globals)
  const usable = offered.filter(t => (permissions?.tools?.allow?.includes(t.name) ?? true) && !(limited && t.kind === 'account'))
  return [
    level === 'editor' ? 'Read, create and update' : 'Read only',
    count(permissions?.collections, catalog.collections.length, 'collections'),
    ...(catalog.globals.length ? [count(permissions?.globals, catalog.globals.length, 'globals')] : []),
    usable.length === offered.length ? 'all tools' : `${usable.length} of ${offered.length} tools`,
  ].join(' · ')
}
