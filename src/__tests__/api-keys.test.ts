import { describe, it, expect } from 'vitest'
import type { Field } from 'payload'
import { createApiKeysCollection, API_KEYS_DEFAULT_SLUG } from '../api-keys'

const baseOptions = {
  userCollection: 'users',
  availableCollections: ['posts', 'pages'],
  availableTools: ['findDocument', 'createDocument', 'safeDelete'],
}

function findNamed(fields: Field[], name: string): Field | undefined {
  for (const f of fields) {
    if ('name' in f && f.name === name) return f
    if (f.type === 'collapsible' || f.type === 'row') {
      const nested = findNamed(f.fields as Field[], name)
      if (nested) return nested
    }
  }
  return undefined
}

describe('createApiKeysCollection', () => {
  it('defaults the slug to payload-mcp-api-keys', () => {
    const collection = createApiKeysCollection(baseOptions)
    expect(collection.slug).toBe(API_KEYS_DEFAULT_SLUG)
    expect(collection.slug).toBe('payload-mcp-api-keys')
  })

  it('honours an explicit slug override', () => {
    const collection = createApiKeysCollection({ ...baseOptions, slug: 'my-custom-keys' })
    expect(collection.slug).toBe('my-custom-keys')
  })

  it('binds the user relationship to the configured user collection', () => {
    const collection = createApiKeysCollection({ ...baseOptions, userCollection: 'admins' })
    const userField = findNamed(collection.fields as Field[], 'user') as { relationTo?: string }
    expect(userField).toBeDefined()
    expect(userField.relationTo).toBe('admins')
  })

  it('throws a useful error when userCollection is missing', () => {
    expect(() =>
      createApiKeysCollection({} as unknown as Parameters<typeof createApiKeysCollection>[0]),
    ).toThrow(/userCollection/)
  })

  it('throws a useful error when availableCollections is missing', () => {
    expect(() =>
      createApiKeysCollection({
        userCollection: 'users',
        availableTools: [],
      } as unknown as Parameters<typeof createApiKeysCollection>[0]),
    ).toThrow(/availableCollections/)
  })

  it('throws a useful error when availableTools is missing', () => {
    expect(() =>
      createApiKeysCollection({
        userCollection: 'users',
        availableCollections: [],
      } as unknown as Parameters<typeof createApiKeysCollection>[0]),
    ).toThrow(/availableTools/)
  })

  it('reuses Payload built-in API key auth so legacy rows stay authenticatable', () => {
    const collection = createApiKeysCollection(baseOptions)
    expect(collection.auth).toMatchObject({
      useAPIKey: true,
      disableLocalStrategy: true,
    })
  })

  it('declares the typed scope surface and lifecycle fields', () => {
    const collection = createApiKeysCollection(baseOptions)
    for (const expected of [
      'name',
      'description',
      'user',
      'preset',
      'collectionScopes',
      'toolAllow',
      'toolDeny',
      'keyPrefix',
      'expiresAt',
      'revokedAt',
      'lastUsedAt',
    ]) {
      expect(findNamed(collection.fields as Field[], expected), `missing field: ${expected}`).toBeDefined()
    }
    // Legacy column must be gone.
    expect(findNamed(collection.fields as Field[], 'scopes')).toBeUndefined()
  })

  it('exposes the four preset values with custom as the default', () => {
    const collection = createApiKeysCollection(baseOptions)
    const preset = findNamed(collection.fields as Field[], 'preset') as {
      required?: boolean
      defaultValue?: string
      options?: Array<{ value: string }>
    }
    expect(preset.required).toBe(true)
    expect(preset.defaultValue).toBe('custom')
    expect(preset.options?.map((o) => o.value)).toEqual([
      'read-only',
      'editor',
      'admin',
      'custom',
    ])
  })

  it('renders collectionScopes as a JSON field with the matrix component and runtime options', () => {
    const collection = createApiKeysCollection({
      ...baseOptions,
      availableCollections: ['a', 'b', 'c'],
    })
    const scopes = findNamed(collection.fields as Field[], 'collectionScopes') as {
      type?: string
      admin?: {
        components?: {
          Field?: {
            path?: string
            exportName?: string
            clientProps?: { availableCollections?: string[] }
          }
        }
        condition?: (data: unknown) => boolean
      }
    }
    expect(scopes.type).toBe('json')
    expect(scopes.admin?.components?.Field?.path).toBe('payload-mcp-toolkit/client')
    expect(scopes.admin?.components?.Field?.exportName).toBe('CollectionScopesMatrix')
    expect(scopes.admin?.components?.Field?.clientProps?.availableCollections).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(scopes.admin?.condition?.({ preset: 'custom' })).toBe(true)
    expect(scopes.admin?.condition?.({ preset: 'editor' })).toBe(false)
  })

  it('renders globalScopes as a JSON field mirroring collectionScopes', () => {
    const collection = createApiKeysCollection({
      ...baseOptions,
      availableGlobals: ['siteSettings', 'footer'],
    })
    const scopes = findNamed(collection.fields as Field[], 'globalScopes') as {
      type?: string
      admin?: {
        components?: {
          Field?: {
            path?: string
            exportName?: string
            clientProps?: { availableGlobals?: string[] }
          }
        }
        condition?: (data: unknown) => boolean
      }
    }
    expect(scopes.type).toBe('json')
    expect(scopes.admin?.components?.Field?.exportName).toBe('GlobalScopesMatrix')
    expect(scopes.admin?.components?.Field?.clientProps?.availableGlobals).toEqual([
      'siteSettings',
      'footer',
    ])
    // Conditional render mirrors collectionScopes: Custom preset only. The
    // empty-config case is handled inside ScopesTable's empty-state render,
    // not by gating the field's admin.condition.
    expect(scopes.admin?.condition?.({ preset: 'custom' })).toBe(true)
    expect(scopes.admin?.condition?.({ preset: 'editor' })).toBe(false)
  })

  it('renders the globalScopes field under Custom even when no globals are available', () => {
    // No `availableGlobals.length > 0` gate — the matrix component renders
    // its own empty-state copy ("No globals are available…") so operators
    // see why the table is blank instead of seeing nothing at all.
    const collection = createApiKeysCollection({ ...baseOptions })
    const scopes = findNamed(collection.fields as Field[], 'globalScopes') as {
      admin?: {
        condition?: (data: unknown) => boolean
        components?: { Field?: { clientProps?: { availableGlobals?: string[] } } }
      }
    }
    expect(scopes).toBeDefined()
    expect(scopes.admin?.condition?.({ preset: 'custom' })).toBe(true)
    expect(scopes.admin?.condition?.({ preset: 'editor' })).toBe(false)
    expect(scopes.admin?.components?.Field?.clientProps?.availableGlobals).toEqual([])
  })

  it('createApiKeysCollection accepts options without availableGlobals (back-compat)', () => {
    // Direct callers from before globals support continue to work.
    expect(() => createApiKeysCollection({ ...baseOptions })).not.toThrow()
  })

  it('groups tool overrides into a custom-only collapsible', () => {
    const collection = createApiKeysCollection(baseOptions)
    const collapsible = (collection.fields as Field[]).find(
      (f) => f.type === 'collapsible' && f.label === 'Tool overrides',
    ) as { admin?: { condition?: (data: unknown) => boolean }; fields?: Field[] } | undefined
    expect(collapsible).toBeDefined()
    expect(collapsible?.admin?.condition?.({ preset: 'custom' })).toBe(true)
    expect(collapsible?.admin?.condition?.({ preset: 'admin' })).toBe(false)

    const toolAllow = (collapsible?.fields ?? []).find(
      (f) => 'name' in f && f.name === 'toolAllow',
    ) as { options?: Array<{ value: string }> } | undefined
    const toolDeny = (collapsible?.fields ?? []).find(
      (f) => 'name' in f && f.name === 'toolDeny',
    ) as { options?: Array<{ value: string }> } | undefined
    expect(toolAllow?.options?.map((o) => o.value)).toEqual(baseOptions.availableTools)
    expect(toolDeny?.options?.map((o) => o.value)).toEqual(baseOptions.availableTools)
  })

  it('places identity and lifecycle fields in the sidebar', () => {
    const collection = createApiKeysCollection(baseOptions)
    for (const expected of ['user', 'keyPrefix', 'expiresAt', 'revokedAt', 'lastUsedAt']) {
      const f = findNamed(collection.fields as Field[], expected) as {
        admin?: { position?: string }
      }
      expect(f.admin?.position, `${expected} should be in the sidebar`).toBe('sidebar')
    }
  })

  it('keyPrefix beforeChange captures first 8 chars of a freshly generated apiKey', () => {
    const collection = createApiKeysCollection(baseOptions)
    const prefixField = findNamed(collection.fields as Field[], 'keyPrefix') as {
      hooks?: { beforeChange?: Array<(args: unknown) => unknown> }
    }

    const hook = prefixField.hooks?.beforeChange?.[0]
    expect(hook).toBeDefined()

    const result = hook!({
      data: { apiKey: 'abc12345-extra-stuff' },
      originalDoc: undefined,
      value: undefined,
    })
    expect(result).toBe('abc12345')
  })

  it('keyPrefix beforeChange preserves an existing prefix when the apiKey is not present (e.g. updates)', () => {
    const collection = createApiKeysCollection(baseOptions)
    const prefixField = findNamed(collection.fields as Field[], 'keyPrefix') as {
      hooks?: { beforeChange?: Array<(args: unknown) => unknown> }
    }
    const hook = prefixField.hooks!.beforeChange![0]

    const result = hook({
      data: {},
      originalDoc: { keyPrefix: 'cafebabe' },
      value: undefined,
    })
    expect(result).toBe('cafebabe')
  })

  it('keyPrefix beforeChange respects a value already provided', () => {
    const collection = createApiKeysCollection(baseOptions)
    const prefixField = findNamed(collection.fields as Field[], 'keyPrefix') as {
      hooks?: { beforeChange?: Array<(args: unknown) => unknown> }
    }
    const hook = prefixField.hooks!.beforeChange![0]

    const result = hook({
      data: { apiKey: 'newvalue-ignored' },
      originalDoc: undefined,
      value: 'preset-prefix',
    })
    expect(result).toBe('preset-prefix')
  })

  it('beforeValidate coerces empty toolAllow/toolDeny to null under preset modes (REST trap fix)', () => {
    const collection = createApiKeysCollection(baseOptions)
    const hook = (collection.hooks?.beforeValidate ?? [])[0] as
      | undefined
      | ((args: { data: unknown; originalDoc?: unknown }) => Record<string, unknown> | undefined)
    expect(hook).toBeDefined()

    const out = hook!({
      data: { preset: 'admin', toolAllow: [], toolDeny: [] },
    }) as Record<string, unknown>
    expect(out.toolAllow).toBeNull()
    expect(out.toolDeny).toBeNull()
  })

  it('beforeValidate preserves explicit-empty toolAllow under the Custom preset when no other scopes are set (fresh-Custom deny-all sentinel)', () => {
    const collection = createApiKeysCollection(baseOptions)
    const hook = (collection.hooks?.beforeValidate ?? [])[0] as
      | undefined
      | ((args: { data: unknown; originalDoc?: unknown }) => Record<string, unknown> | undefined)

    const out = hook!({
      data: { preset: 'custom', toolAllow: [], toolDeny: [] },
    }) as Record<string, unknown>
    expect(out.toolAllow).toEqual([])
    expect(out.toolDeny).toEqual([])
  })

  it('beforeValidate nulls empty toolAllow under Custom when collectionScopes carry entries (override label semantic)', () => {
    const collection = createApiKeysCollection(baseOptions)
    const hook = (collection.hooks?.beforeValidate ?? [])[0] as
      | undefined
      | ((args: { data: unknown; originalDoc?: unknown }) => Record<string, unknown> | undefined)

    const out = hook!({
      data: {
        preset: 'custom',
        collectionScopes: [{ slug: 'pages', actions: ['read'] }],
        toolAllow: [],
        toolDeny: [],
      },
    }) as Record<string, unknown>
    expect(out.toolAllow).toBeNull()
    expect(out.toolDeny).toEqual([])
    expect(out.collectionScopes).toEqual([{ slug: 'pages', actions: ['read'] }])
  })

  it('beforeValidate nulls a MISSING toolAllow under Custom when collectionScopes carry entries (Local API key creation)', () => {
    const collection = createApiKeysCollection(baseOptions)
    const hook = (collection.hooks?.beforeValidate ?? [])[0] as
      | undefined
      | ((args: { data: unknown; originalDoc?: unknown }) => Record<string, unknown> | undefined)

    // A key created through payload.create() omits toolAllow entirely. Payload
    // reads the unset hasMany select back as `[]`, which composeScopes would
    // otherwise honour as deny-all on the tools axis — every call rejected.
    const out = hook!({
      data: {
        preset: 'custom',
        collectionScopes: [{ slug: 'pages', actions: ['read'] }],
      },
    }) as Record<string, unknown>
    expect(out.toolAllow).toBeNull()
    expect(out.collectionScopes).toEqual([{ slug: 'pages', actions: ['read'] }])
  })

  it('beforeValidate nulls empty toolAllow under Custom when globalScopes carry entries', () => {
    const collection = createApiKeysCollection(baseOptions)
    const hook = (collection.hooks?.beforeValidate ?? [])[0] as
      | undefined
      | ((args: { data: unknown; originalDoc?: unknown }) => Record<string, unknown> | undefined)

    const out = hook!({
      data: {
        preset: 'custom',
        globalScopes: [{ slug: 'header', actions: ['read'] }],
        toolAllow: [],
      },
    }) as Record<string, unknown>
    expect(out.toolAllow).toBeNull()
  })

  it('beforeValidate preserves populated toolAllow under Custom (explicit whitelist still honoured)', () => {
    const collection = createApiKeysCollection(baseOptions)
    const hook = (collection.hooks?.beforeValidate ?? [])[0] as
      | undefined
      | ((args: { data: unknown; originalDoc?: unknown }) => Record<string, unknown> | undefined)

    const out = hook!({
      data: {
        preset: 'custom',
        collectionScopes: [{ slug: 'pages', actions: ['read'] }],
        toolAllow: ['findDocument'],
      },
    }) as Record<string, unknown>
    expect(out.toolAllow).toEqual(['findDocument'])
  })

  it('beforeValidate nulls populated tool/scope arrays under non-Custom presets (Custom→Admin switch fix)', () => {
    const collection = createApiKeysCollection(baseOptions)
    const hook = (collection.hooks?.beforeValidate ?? [])[0] as
      | undefined
      | ((args: { data: unknown; originalDoc?: unknown }) => Record<string, unknown> | undefined)

    const out = hook!({
      data: {
        preset: 'admin',
        toolAllow: ['findDocument'],
        toolDeny: ['safeDelete'],
        collectionScopes: [{ slug: 'pages', actions: ['read'] }],
        globalScopes: [{ slug: 'header', actions: ['read'] }],
      },
    }) as Record<string, unknown>
    expect(out.toolAllow).toBeNull()
    expect(out.toolDeny).toBeNull()
    expect(out.collectionScopes).toBeNull()
    expect(out.globalScopes).toBeNull()
  })

  it('beforeValidate nulls stale override fields on originalDoc when admin-form `data` omits hidden fields (admin UI conditional-field trap)', () => {
    const collection = createApiKeysCollection(baseOptions)
    const hook = (collection.hooks?.beforeValidate ?? [])[0] as
      | undefined
      | ((args: { data: unknown; originalDoc?: unknown }) => Record<string, unknown> | undefined)

    const out = hook!({
      data: { preset: 'admin' },
      originalDoc: {
        preset: 'custom',
        toolAllow: ['findDocument'],
        toolDeny: ['safeDelete'],
        collectionScopes: [{ slug: 'pages', actions: ['read'] }],
        globalScopes: [{ slug: 'header', actions: ['read'] }],
      },
    }) as Record<string, unknown>
    expect(out.toolAllow).toBeNull()
    expect(out.toolDeny).toBeNull()
    expect(out.collectionScopes).toBeNull()
    expect(out.globalScopes).toBeNull()
  })

  it('beforeValidate preserves populated override arrays under the Custom preset', () => {
    const collection = createApiKeysCollection(baseOptions)
    const hook = (collection.hooks?.beforeValidate ?? [])[0] as
      | undefined
      | ((args: { data: unknown; originalDoc?: unknown }) => Record<string, unknown> | undefined)

    const out = hook!({
      data: {
        preset: 'custom',
        toolAllow: ['findDocument'],
        toolDeny: ['safeDelete'],
        collectionScopes: [{ slug: 'pages', actions: ['read'] }],
        globalScopes: [{ slug: 'header', actions: ['read'] }],
      },
    }) as Record<string, unknown>
    expect(out.toolAllow).toEqual(['findDocument'])
    expect(out.toolDeny).toEqual(['safeDelete'])
    expect(out.collectionScopes).toEqual([{ slug: 'pages', actions: ['read'] }])
    expect(out.globalScopes).toEqual([{ slug: 'header', actions: ['read'] }])
  })

  it('beforeValidate Custom→Admin→Custom round-trip: returning to Custom from an already-cleared row lands on the deny-all sentinel (documented in the preset field description)', () => {
    const collection = createApiKeysCollection(baseOptions)
    const hook = (collection.hooks?.beforeValidate ?? [])[0] as
      | undefined
      | ((args: { data: unknown; originalDoc?: unknown }) => Record<string, unknown> | undefined)

    const out = hook!({
      data: { preset: 'custom' },
      originalDoc: {
        preset: 'admin',
        toolAllow: null,
        toolDeny: null,
        collectionScopes: null,
        globalScopes: null,
      },
    }) as Record<string, unknown>
    expect(out.preset).toBe('custom')
    // No coercion fires: no concrete scopes anywhere → composeScopes
    // fresh-Custom sentinel emits deny-all. This matches the preset
    // field description warning that re-entering Custom starts fresh.
    expect(out.toolAllow).toBeUndefined()
    expect(out.collectionScopes).toBeUndefined()
  })

  it('beforeValidate honours originalDoc.collectionScopes when data omits the hidden Custom field (partial admin-form save)', () => {
    const collection = createApiKeysCollection(baseOptions)
    const hook = (collection.hooks?.beforeValidate ?? [])[0] as
      | undefined
      | ((args: { data: unknown; originalDoc?: unknown }) => Record<string, unknown> | undefined)

    // Data omits collectionScopes entirely; originalDoc carries them.
    // The Custom-branch effective-readers fall through to originalDoc, so
    // hasCollectionEntries=true → empty toolAllow in data is coerced to
    // null (override-label semantic preserved).
    const out = hook!({
      data: { preset: 'custom', toolAllow: [] },
      originalDoc: {
        preset: 'custom',
        collectionScopes: [{ slug: 'pages', actions: ['read'] }],
      },
    }) as Record<string, unknown>
    expect(out.toolAllow).toBeNull()
  })
})
