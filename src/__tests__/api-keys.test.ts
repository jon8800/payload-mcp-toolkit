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
    // Conditional render: only Custom preset AND availableGlobals.length > 0
    expect(scopes.admin?.condition?.({ preset: 'custom' })).toBe(true)
    expect(scopes.admin?.condition?.({ preset: 'editor' })).toBe(false)
  })

  it('omits the globalScopes matrix from the form when no globals are available', () => {
    const collection = createApiKeysCollection({ ...baseOptions })
    const scopes = findNamed(collection.fields as Field[], 'globalScopes') as {
      admin?: { condition?: (data: unknown) => boolean }
    }
    // Field is still registered (so its column exists), but the admin condition
    // is false even under Custom so no UI flickers in for empty configs.
    expect(scopes).toBeDefined()
    expect(scopes.admin?.condition?.({ preset: 'custom' })).toBe(false)
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
})
