import { describe, it, expect } from 'vitest'
import { createApiKeysCollection, API_KEYS_DEFAULT_SLUG } from '../api-keys'

describe('createApiKeysCollection', () => {
  it('defaults the slug to payload-mcp-api-keys', () => {
    const collection = createApiKeysCollection({ userCollection: 'users' })
    expect(collection.slug).toBe(API_KEYS_DEFAULT_SLUG)
    expect(collection.slug).toBe('payload-mcp-api-keys')
  })

  it('honours an explicit slug override', () => {
    const collection = createApiKeysCollection({ slug: 'my-custom-keys', userCollection: 'users' })
    expect(collection.slug).toBe('my-custom-keys')
  })

  it('binds the user relationship to the configured user collection', () => {
    const collection = createApiKeysCollection({ userCollection: 'admins' })
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

  it('reuses Payload built-in API key auth so legacy rows stay authenticatable', () => {
    const collection = createApiKeysCollection({ userCollection: 'users' })
    expect(collection.auth).toMatchObject({
      useAPIKey: true,
      disableLocalStrategy: true,
    })
  })

  it('declares the v0.4 lifecycle and authorization surface', () => {
    const collection = createApiKeysCollection({ userCollection: 'users' })
    const fieldNames = collection.fields
      .map((f) => ('name' in f ? f.name : null))
      .filter((n): n is string => typeof n === 'string')

    for (const expected of [
      'name',
      'description',
      'user',
      'scopes',
      'keyPrefix',
      'expiresAt',
      'revokedAt',
      'lastUsedAt',
    ]) {
      expect(fieldNames, `missing field: ${expected}`).toContain(expected)
    }
  })

  it('keyPrefix beforeChange captures first 8 chars of a freshly generated apiKey', () => {
    const collection = createApiKeysCollection({ userCollection: 'users' })
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
    const collection = createApiKeysCollection({ userCollection: 'users' })
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
    const collection = createApiKeysCollection({ userCollection: 'users' })
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
