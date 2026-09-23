import type { CollectionConfig, Payload } from 'payload'
import { hashKey } from './hash'

export const OAUTH_COLLECTION = 'payload-mcp-oauth'

export interface OAuthRecord {
  id: string | number
  key: string
  kind: 'grant' | 'code' | 'access' | 'refresh' | 'used'
  expiresAt: string
  owner?: string
  data: Record<string, unknown>
}

export function createOAuthCollection(): CollectionConfig {
  return {
    slug: OAUTH_COLLECTION,
    admin: { hidden: true },
    access: { create: () => false, read: () => false, update: () => false, delete: () => false },
    fields: [
      { name: 'key', type: 'text', required: true, unique: true },
      { name: 'kind', type: 'select', required: true, options: ['grant', 'code', 'access', 'refresh', 'used'] },
      { name: 'expiresAt', type: 'date', required: true, index: true },
      { name: 'owner', type: 'text', index: true },
      { name: 'data', type: 'json', required: true },
    ],
  }
}

export function tokenKey(payload: Payload, token: string): string {
  return hashKey(`oauth:${token}`, payload.secret)
}

export async function readRecord(payload: Payload, key: string): Promise<OAuthRecord | undefined> {
  const result = await payload.find({
    collection: OAUTH_COLLECTION, where: { key: { equals: key } },
    limit: 1, depth: 0, pagination: false, overrideAccess: true,
  })
  return result.docs[0] as unknown as OAuthRecord | undefined
}

export async function writeRecord(payload: Payload, record: Omit<OAuthRecord, 'id'>): Promise<void> {
  await payload.create({ collection: OAUTH_COLLECTION, data: record, overrideAccess: true })
}

export function isLive(record: OAuthRecord | undefined): record is OAuthRecord {
  return !!record && Date.parse(record.expiresAt) > Date.now()
}

export async function consumeRecord(payload: Payload, record: OAuthRecord): Promise<boolean> {
  const key = `used:${record.key}`
  // A unique INSERT elects one winner across processes. Payload's update(where) is not a CAS.
  try {
    await writeRecord(payload, { key, kind: 'used', expiresAt: record.expiresAt, data: {} })
    return true
  } catch (error) {
    const validation = error as { name?: string; data?: { collection?: string; errors?: { path?: string }[] } }
    // Payload normalizes adapter uniqueness errors to a field ValidationError.
    if (validation?.name !== 'ValidationError' || validation.data?.collection !== OAUTH_COLLECTION ||
      validation.data.errors?.length !== 1 || validation.data.errors[0].path !== 'key') throw error
    if (await readRecord(payload, key)) return false
    throw error
  }
}

export async function revokeGrant(payload: Payload, grant: OAuthRecord): Promise<void> {
  await payload.update({ collection: OAUTH_COLLECTION, id: grant.id,
    data: { expiresAt: new Date(0).toISOString() }, overrideAccess: true })
}

/** Run periodically in the host's existing scheduler. Never remove unexpired consumption claims. */
export async function pruneOAuthRecords(payload: Payload): Promise<void> {
  await payload.delete({ collection: OAUTH_COLLECTION,
    where: { expiresAt: { less_than: new Date().toISOString() } }, overrideAccess: true })
}
