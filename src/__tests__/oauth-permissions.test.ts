import { describe, expect, it } from 'vitest'
import { clampScopes, fullChoice, permissionsFrom, summarize, toolsFor, type Catalog } from '../oauth-permissions'
import { buildScopeChecker } from '../scope/policy'

const catalog: Catalog = { collections: ['posts', 'pages'], globals: ['settings'], tools: [
  { name: 'findDocument', kind: 'collection', action: 'read' },
  { name: 'createDocument', kind: 'collection', action: 'create' },
  { name: 'deleteDocument', kind: 'collection', action: 'delete' },
  { name: 'safeDelete', kind: 'collection', action: 'delete' },
  { name: 'findGlobal', kind: 'global', action: 'read' },
  { name: 'updateGlobal', kind: 'global', action: 'update' },
  { name: 'searchContent', kind: 'account', action: 'read' },
  { name: 'uploadMedia', kind: 'account', action: 'create' },
] }
const check = buildScopeChecker(catalog.tools.map(t => ({ name: t.name, routing: { kind: t.kind, action: t.action } as never })))

describe('OAuth consent permissions', () => {
  it('offers only tools a grant at the level could ever run', () => {
    expect(toolsFor(catalog, 'read-only').map(t => t.name)).toEqual(['findDocument', 'findGlobal', 'searchContent'])
    expect(toolsFor(catalog, 'editor').map(t => t.name)).toEqual(['findDocument', 'createDocument', 'findGlobal', 'searchContent', 'uploadMedia'])
  })

  it('stores no lists for a full choice, so account-wide tools keep working', () => {
    for (const level of ['read-only', 'editor'] as const) {
      expect(permissionsFrom(fullChoice(catalog, level), catalog, 'editor')).toEqual({ level, permissions: { preset: level } })
      expect(permissionsFrom({ level }, catalog, 'editor').permissions).toEqual({ preset: level })
    }
    expect(check({ preset: 'editor' }, 'searchContent', undefined).allowed).toBe(true)
  })

  it('whitelists a partial choice, and the scope checker enforces it', () => {
    const { permissions } = permissionsFrom({ level: 'editor', collections: { posts: ['read', 'create'], pages: [] } }, catalog, 'editor')
    expect(permissions).toEqual({ preset: 'editor', collections: { posts: ['read', 'create'] } })
    expect(check(permissions, 'createDocument', 'posts').allowed).toBe(true)
    expect(check(permissions, 'findDocument', 'pages').allowed).toBe(false)
    expect(check(permissions, 'searchContent', undefined).allowed).toBe(false)
  })

  it('drops anything outside the catalog, the level or the maximum', () => {
    const choice = JSON.parse('{"level":"editor","collections":{"__proto__":["read"],"posts":["delete","read","read"],"users":["read"]},"globals":{"settings":["update","read"]},"tools":["deleteDocument","findDocument","updateGlobal","mystery"]}')
    expect(permissionsFrom(choice, catalog, 'editor').permissions).toEqual({
      preset: 'editor', collections: { posts: ['read'] }, tools: { allow: ['findDocument'] },
    })
    expect(permissionsFrom(choice, catalog, 'read-only')).toEqual({ level: 'read-only', permissions: {
      preset: 'read-only', collections: { posts: ['read'] }, tools: { allow: ['findDocument'] },
    } })
  })

  it('treats a malformed list as nothing picked, never as everything', () => {
    expect(permissionsFrom({ level: 'read-only', collections: 'all' as never, tools: 'all' as never }, catalog, 'editor').permissions)
      .toEqual({ preset: 'read-only', collections: {}, tools: { allow: [] } })
  })

  it('re-caps stored lists when the token or site level shrinks', () => {
    const stored = { preset: 'editor' as const, collections: { posts: ['read' as const, 'create' as const] }, globals: { settings: ['read' as const] }, tools: { allow: ['createDocument'] } }
    expect(clampScopes(stored, 'editor')).toEqual(stored)
    expect(clampScopes(stored, 'read-only')).toEqual({ ...stored, preset: 'read-only', collections: { posts: ['read'] } })
    expect(check(clampScopes(stored, 'read-only'), 'createDocument', 'posts').allowed).toBe(false)
    expect(clampScopes({ preset: 'admin', collections: { posts: ['delete'] } }, 'editor')).toEqual({ preset: 'read-only', collections: { posts: [] } })
  })

  it('summarizes a grant for the connections page', () => {
    expect(summarize(undefined, 'editor', catalog)).toBe('Read, create and update · all collections · all globals · all tools')
    expect(summarize({ preset: 'read-only', collections: { posts: ['read'] }, tools: { allow: ['findDocument'] } }, 'read-only', catalog))
      .toBe('Read only · 1 of 2 collections · all globals · 1 of 3 tools')
    expect(summarize(undefined, 'read-only', { ...catalog, globals: [] })).toBe('Read only · all collections · all tools')
    // Limiting collections switches off account-wide tools, and the count says so.
    expect(summarize({ collections: { posts: ['read'] } }, 'read-only', catalog)).toBe('Read only · 1 of 2 collections · all globals · 2 of 3 tools')
  })
})
