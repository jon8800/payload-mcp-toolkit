import { describe, it, expect, vi } from 'vitest'
import type { CollectionConfig } from 'payload'
import { createFindDocumentTool } from '../tools/find-document.js'
import type { CollectionSchema } from '../types.js'

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

    const result = await tool.handler({ collection: 'posts', documentId: 'a' }, req as never, {})
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

  it('reads linked entries as IDs and refuses dotted filters when access is limited to some collections', async () => {
    const tool = createFindDocumentTool(schemas, drafts, configs, undefined)
    const req = buildReq()
    req.payload.find.mockResolvedValue({ docs: [], totalDocs: 0 })
    await tool.handler({ collection: 'posts', depth: 2 }, req as never, {})
    expect(req.payload.find).toHaveBeenLastCalledWith(expect.objectContaining({ depth: 2 }))

    const limited = { ...buildReq(), context: { mcpLimitedScope: true } }
    limited.payload.find.mockResolvedValue({ docs: [], totalDocs: 0 })
    await tool.handler({ collection: 'posts', depth: 2 }, limited as never, {})
    expect(limited.payload.find).toHaveBeenLastCalledWith(expect.objectContaining({ depth: 0 }))
    const dotted = await tool.handler({ collection: 'posts', where: '{"or":[{"author.email":{"like":"a"}}]}' }, limited as never, {})
    expect(dotted.content[0]!.text).toContain('dotted path')
    expect(limited.payload.find).toHaveBeenCalledTimes(1)
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

    const result = await tool.handler({ collection: 'posts', documentId: 'a' }, req as never, {})
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

    const result = await tool.handler({ collection: 'posts', documentId: 'a' }, req as never, {})
    const allText = result.content.map((c) => c.text).join('\n')
    expect(allText).toMatch(/admin panel/i)
  })

  it('omits preview decoration entirely when previewDisabled is true', async () => {
    const tool = createFindDocumentTool(
      schemas,
      drafts,
      configs,
      'https://app.example.com',
      true,
    )
    const req = buildReq()
    req.payload.findByID.mockResolvedValue({ id: 'a', slug: 'hello', _status: 'draft' })
    const result = await tool.handler({ collection: 'posts', documentId: 'a' }, req as never, {})
    expect(result.content).toHaveLength(1)
    const decoration = result.content.slice(1)
    expect(decoration).toHaveLength(0)
  })

  it('catches errors and returns text error response, no exception', async () => {
    const tool = createFindDocumentTool(schemas, drafts, configs, undefined)
    const req = buildReq()
    req.payload.findByID.mockRejectedValue(new Error('not found'))
    const result = await tool.handler({ collection: 'posts', documentId: 'a' }, req as never, {})
    expect(result.content[0]!.text).toMatch(/Error reading from posts/)
  })
})

describe('findDocument defaults match its description', () => {
  const tool = createFindDocumentTool(new Map([['posts', fakeSchema]]), new Set(['posts']), new Map([['posts', draftCollectionConfig]]), undefined, true)

  it('lists summary fields at depth 0, and reads one document complete at depth 1', async () => {
    expect(tool.description).toContain('A list returns summary fields only (id, title or name, slug, _status, updatedAt) at depth 0')
    expect(tool.parameters.depth.description).toContain('Default 0 for lists, 1 for a single document')
    const req = buildReq()
    req.payload.find.mockResolvedValue({ docs: [], totalDocs: 0 })
    req.payload.findByID.mockResolvedValue({ id: 'a' })

    await tool.handler({ collection: 'posts' }, req as never, {})
    expect(req.payload.find).toHaveBeenLastCalledWith(expect.objectContaining({
      depth: 0, select: { title: true, name: true, slug: true, _status: true, updatedAt: true },
    }))
    await tool.handler({ collection: 'posts', full: true }, req as never, {})
    expect(req.payload.find.mock.lastCall![0]).not.toHaveProperty('select')
    await tool.handler({ collection: 'posts', select: ['title', 'meta.description'], depth: 2 }, req as never, {})
    expect(req.payload.find).toHaveBeenLastCalledWith(expect.objectContaining({ depth: 2, select: { title: true, meta: { description: true } } }))

    await tool.handler({ collection: 'posts', documentId: 'a' }, req as never, {})
    expect(req.payload.findByID).toHaveBeenLastCalledWith(expect.objectContaining({ depth: 1 }))
    expect(req.payload.findByID.mock.lastCall![0]).not.toHaveProperty('select')
  })

  it('passes numeric IDs as numbers on number-ID databases, the same as Payload REST routes', async () => {
    const req = { ...buildReq(), payload: { ...buildReq().payload, db: { defaultIDType: 'number' }, collections: { posts: {} } } }
    req.payload.findByID.mockResolvedValue({ id: 12 })
    await tool.handler({ collection: 'posts', documentId: '12' }, req as never, {})
    expect(req.payload.findByID).toHaveBeenLastCalledWith(expect.objectContaining({ id: 12 }))
    await tool.handler({ collection: 'posts', documentId: '64f0c0ffee' }, req as never, {})
    expect(req.payload.findByID).toHaveBeenLastCalledWith(expect.objectContaining({ id: '64f0c0ffee' }))
    req.payload.collections.posts = { customIDType: 'text' }
    await tool.handler({ collection: 'posts', documentId: '12' }, req as never, {})
    expect(req.payload.findByID).toHaveBeenLastCalledWith(expect.objectContaining({ id: '12' }))
  })
})
