import { describe, it, expect } from 'vitest'
import { createApiKeysCollection, API_KEYS_DEFAULT_SLUG } from '../api-keys'

const baseOptions = {
  userCollection: 'users',
  availableCollections: ['posts', 'pages'],
  availableTools: ['findDocument', 'createDocument', 'safeDelete'],
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
    const userField = collection.fields.find(
      (f): f is Extract<typeof f, { name: 'user' }> => 'name' in f && f.name === 'user',
    )
    expect(userField).toBeDefined()
    expect((userField as { relationTo: string }).relationTo).toBe('admins')
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
    const fieldNames = collection.fields
      .map((f) => ('name' in f ? f.name : null))
      .filter((n): n is string => typeof n === 'string')

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
      'scopes',
    ]) {
      expect(fieldNames, `missing field: ${expected}`).toContain(expected)
    }
  })

  it('exposes the four preset values with custom as the default', () => {
    const collection = createApiKeysCollection(baseOptions)
    const preset = collection.fields.find(
      (f): f is Extract<typeof f, { name: 'preset' }> => 'name' in f && f.name === 'preset',
    ) as {
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

  it('populates collectionScopes options from availableCollections', () => {
    const collection = createApiKeysCollection({ ...baseOptions, availableCollections: ['a', 'b', 'c'] })
    const scopes = collection.fields.find(
      (f): f is Extract<typeof f, { name: 'collectionScopes' }> =>
        'name' in f && f.name === 'collectionScopes',
    ) as { fields: Array<{ name: string; options?: Array<{ value: string }> }> }
    const collectionField = scopes.fields.find((f) => f.name === 'collection')
    expect(collectionField?.options?.map((o) => o.value)).toEqual(['a', 'b', 'c'])
  })

  it('hides collectionScopes / toolAllow when preset is not custom', () => {
    const collection = createApiKeysCollection(baseOptions)
    type WithCondition = { admin?: { condition?: (data: unknown) => boolean } }

    const collScopes = collection.fields.find(
      (f) => 'name' in f && f.name === 'collectionScopes',
    ) as WithCondition
    const toolAllow = collection.fields.find(
      (f) => 'name' in f && f.name === 'toolAllow',
    ) as WithCondition
    const toolDeny = collection.fields.find(
      (f) => 'name' in f && f.name === 'toolDeny',
    ) as WithCondition

    expect(collScopes.admin?.condition?.({ preset: 'custom' })).toBe(true)
    expect(collScopes.admin?.condition?.({ preset: 'editor' })).toBe(false)
    expect(toolAllow.admin?.condition?.({ preset: 'custom' })).toBe(true)
    expect(toolAllow.admin?.condition?.({ preset: 'admin' })).toBe(false)
    // toolDeny applies on top of any preset; no condition expected
    expect(toolDeny.admin?.condition).toBeUndefined()
  })

  it('populates toolAllow / toolDeny options from availableTools', () => {
    const collection = createApiKeysCollection({ ...baseOptions, availableTools: ['x', 'y'] })
    const toolAllow = collection.fields.find(
      (f): f is Extract<typeof f, { name: 'toolAllow' }> => 'name' in f && f.name === 'toolAllow',
    ) as { options?: Array<{ value: string }> }
    const toolDeny = collection.fields.find(
      (f): f is Extract<typeof f, { name: 'toolDeny' }> => 'name' in f && f.name === 'toolDeny',
    ) as { options?: Array<{ value: string }> }
    expect(toolAllow.options?.map((o) => o.value)).toEqual(['x', 'y'])
    expect(toolDeny.options?.map((o) => o.value)).toEqual(['x', 'y'])
  })

  it('keeps the legacy scopes JSON column hidden and read-only', () => {
    const collection = createApiKeysCollection(baseOptions)
    const legacy = collection.fields.find(
      (f): f is Extract<typeof f, { name: 'scopes' }> => 'name' in f && f.name === 'scopes',
    ) as { admin?: { hidden?: boolean; readOnly?: boolean } }
    expect(legacy.admin?.hidden).toBe(true)
    expect(legacy.admin?.readOnly).toBe(true)
  })

  it('keyPrefix beforeChange captures first 8 chars of a freshly generated apiKey', () => {
    const collection = createApiKeysCollection(baseOptions)
    const prefixField = collection.fields.find(
      (f): f is Extract<typeof f, { name: 'keyPrefix' }> => 'name' in f && f.name === 'keyPrefix',
    ) as { hooks?: { beforeChange?: Array<(args: unknown) => unknown> } }

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
    const prefixField = collection.fields.find(
      (f): f is Extract<typeof f, { name: 'keyPrefix' }> => 'name' in f && f.name === 'keyPrefix',
    ) as { hooks?: { beforeChange?: Array<(args: unknown) => unknown> } }
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
    const prefixField = collection.fields.find(
      (f): f is Extract<typeof f, { name: 'keyPrefix' }> => 'name' in f && f.name === 'keyPrefix',
    ) as { hooks?: { beforeChange?: Array<(args: unknown) => unknown> } }
    const hook = prefixField.hooks!.beforeChange![0]

    const result = hook({
      data: { apiKey: 'newvalue-ignored' },
      originalDoc: undefined,
      value: 'preset-prefix',
    })
    expect(result).toBe('preset-prefix')
  })
})
