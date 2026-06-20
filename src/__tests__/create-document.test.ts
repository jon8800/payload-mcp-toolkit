import { describe, it, expect, vi } from 'vitest'
import { createCreateDocumentTool } from '../tools/create-document'
import type { CollectionSchema } from '../types'

const schemas = new Map<string, CollectionSchema>([
  ['posts', { fields: [{ name: 'title' }] } as CollectionSchema],
  ['authors', { fields: [{ name: 'name' }] } as CollectionSchema],
])

function buildReq(create: ReturnType<typeof vi.fn>) {
  return {
    payload: {
      create,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    context: {},
    user: null,
  }
}

describe('createDocument _status on draft-enabled collections', () => {
  const draftCollections = new Set(['posts'])

  function createdArg(create: ReturnType<typeof vi.fn>) {
    return create.mock.calls[0]![0] as { draft: boolean; data: Record<string, unknown> }
  }

  it('sets _status:published when draft:false (the reported bug — main row was staying draft)', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'p1', title: 'Hello' })
    const tool = createCreateDocumentTool(schemas, draftCollections)
    await tool.handler(
      { collection: 'posts', data: '{"title":"Hello"}', draft: false },
      buildReq(create) as never,
      {},
    )
    const arg = createdArg(create)
    expect(arg.draft).toBe(false)
    expect(arg.data._status).toBe('published')
  })

  it('defaults to _status:draft when draft is unspecified on a draft collection', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'p1' })
    const tool = createCreateDocumentTool(schemas, draftCollections)
    await tool.handler(
      { collection: 'posts', data: '{"title":"Hi"}' },
      buildReq(create) as never,
      {},
    )
    const arg = createdArg(create)
    expect(arg.draft).toBe(true)
    expect(arg.data._status).toBe('draft')
  })

  it('does not inject _status on a non-draft collection', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'a1' })
    const tool = createCreateDocumentTool(schemas, draftCollections)
    await tool.handler(
      { collection: 'authors', data: '{"name":"X"}', draft: false },
      buildReq(create) as never,
      {},
    )
    expect(createdArg(create).data._status).toBeUndefined()
  })

  it('respects a caller-provided _status instead of overriding it', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'p1' })
    const tool = createCreateDocumentTool(schemas, draftCollections)
    await tool.handler(
      { collection: 'posts', data: '{"title":"Hi","_status":"draft"}', draft: false },
      buildReq(create) as never,
      {},
    )
    expect(createdArg(create).data._status).toBe('draft')
  })
})
