import { describe, it, expect, vi } from 'vitest'
import type { CollectionConfig } from 'payload'
import { createFindDocumentTool } from '../tools/find-document'
import type { CollectionSchema } from '../types'

const fakeSchema: CollectionSchema = {
  slug: 'posts',
  fields: [],
  searchableFields: [],
  hasDrafts: true,
} as never

const draftCollectionConfig: CollectionConfig = {
  slug: 'posts',
  admin: {
    livePreview: {
      url: ({ data }: { data: Record<string, unknown> }) =>
        `/preview/posts/${data.slug ?? data.id ?? ''}`,
    },
  } as never,
  fields: [],
  versions: { drafts: true },
}

function buildReq() {
  return {
    payload: {
      find: vi.fn(),
      findByID: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    context: {},
    user: null,
  }
}

describe('findDocument', () => {
  const schemas = new Map([['posts', fakeSchema]])
  const drafts = new Set(['posts'])
  const configs = new Map([['posts', draftCollectionConfig]])

  it('calls findByID with overrideAccess:false when id is set', async () => {
    const tool = createFindDocumentTool(schemas, drafts, configs, 'https://app.example.com')
    const req = buildReq()
    req.payload.findByID.mockResolvedValue({ id: 'a', _status: 'published' })

    const result = await tool.handler({ collection: 'posts', id: 'a' }, req as never, {})
    expect(req.payload.findByID).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'posts',
        id: 'a',
        overrideAccess: false,
      }),
    )
    expect(result.content[0]!.text).toContain('"id":"a"')
  })

  it('parses the where JSON string and forwards it to find()', async () => {
    const tool = createFindDocumentTool(schemas, drafts, configs, undefined)
    const req = buildReq()
    req.payload.find.mockResolvedValue({ docs: [], totalDocs: 0 })

    await tool.handler(
      { collection: 'posts', where: '{"status":{"equals":"published"}}', limit: 10 },
      req as never,
      {},
    )
    expect(req.payload.find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'posts',
        where: { status: { equals: 'published' } },
        limit: 10,
        overrideAccess: false,
      }),
    )
  })

  it('returns a text error response (no exception) on invalid where JSON', async () => {
    const tool = createFindDocumentTool(schemas, drafts, configs, undefined)
    const req = buildReq()

    const result = await tool.handler(
      { collection: 'posts', where: 'not-json' },
      req as never,
      {},
    )
    expect(result.content[0]!.text).toMatch(/valid JSON/)
    expect(req.payload.find).not.toHaveBeenCalled()
  })

  it('returns a text error response when collection is not registered', async () => {
    const tool = createFindDocumentTool(schemas, drafts, configs, undefined)
    const req = buildReq()
    const result = await tool.handler({ collection: 'unknown' }, req as never, {})
    expect(result.content[0]!.text).toMatch(/Unknown collection/)
  })

  it('appends a preview URL when a draft document is returned by id lookup', async () => {
    const tool = createFindDocumentTool(schemas, drafts, configs, 'https://app.example.com')
    const req = buildReq()
    req.payload.findByID.mockResolvedValue({ id: 'a', slug: 'hello', _status: 'draft' })

    const result = await tool.handler({ collection: 'posts', id: 'a' }, req as never, {})
    const allText = result.content.map((c) => c.text).join('\n')
    expect(allText).toMatch(/draft/i)
    expect(allText).toContain('https://app.example.com/preview/posts/hello')
  })

  it('falls back to the admin-panel hint when the collection has no preview function', async () => {
    const noPreviewConfig: CollectionConfig = { slug: 'posts', fields: [] }
    const tool = createFindDocumentTool(
      schemas,
      drafts,
      new Map([['posts', noPreviewConfig]]),
      undefined,
    )
    const req = buildReq()
    req.payload.findByID.mockResolvedValue({ id: 'a', _status: 'draft' })

    const result = await tool.handler({ collection: 'posts', id: 'a' }, req as never, {})
    const allText = result.content.map((c) => c.text).join('\n')
    expect(allText).toMatch(/admin panel/i)
  })

  it('catches errors and returns text error response, no exception', async () => {
    const tool = createFindDocumentTool(schemas, drafts, configs, undefined)
    const req = buildReq()
    req.payload.findByID.mockRejectedValue(new Error('not found'))
    const result = await tool.handler({ collection: 'posts', id: 'a' }, req as never, {})
    expect(result.content[0]!.text).toMatch(/Error reading from posts/)
  })
})
