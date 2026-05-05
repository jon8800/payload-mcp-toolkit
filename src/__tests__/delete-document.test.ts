import { describe, it, expect, vi } from 'vitest'
import { createDeleteDocumentTool } from '../tools/delete-document'
import type { CollectionSchema } from '../types'

const fakeSchema: CollectionSchema = {
  slug: 'posts',
  fields: [],
  searchableFields: [],
  hasDrafts: false,
} as never

function buildReq() {
  return {
    payload: {
      delete: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    context: {},
    user: null,
  }
}

describe('deleteDocument', () => {
  const schemas = new Map([['posts', fakeSchema]])

  it('deletes via payload.delete with overrideAccess:false and returns success text', async () => {
    const tool = createDeleteDocumentTool(schemas)
    const req = buildReq()
    req.payload.delete.mockResolvedValue({ id: 'a', name: 'Hello' })

    const result = await tool.handler({ collection: 'posts', id: 'a' }, req as never, {})
    expect(req.payload.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'posts',
        id: 'a',
        overrideAccess: false,
      }),
    )
    expect(result.content[0]!.text).toMatch(/Deleted "Hello"/)
  })

  it('returns text error response when the doc does not exist (no throw)', async () => {
    const tool = createDeleteDocumentTool(schemas)
    const req = buildReq()
    req.payload.delete.mockRejectedValue(new Error('not found'))

    const result = await tool.handler({ collection: 'posts', id: 'missing' }, req as never, {})
    expect(result.content[0]!.text).toMatch(/Error deleting missing from posts/)
  })

  it('rejects unknown collections at the boundary', async () => {
    const tool = createDeleteDocumentTool(schemas)
    const req = buildReq()
    const result = await tool.handler({ collection: 'unknown', id: 'x' }, req as never, {})
    expect(result.content[0]!.text).toMatch(/Unknown collection/)
    expect(req.payload.delete).not.toHaveBeenCalled()
  })
})
