import { describe, it, expect, vi } from 'vitest'
import { createPublishDraftTool } from '../tools/publish-draft'
import { createPublishGlobalDraftTool } from '../tools/publish-global-draft'

function buildReq(overrides?: {
  update?: ReturnType<typeof vi.fn>
  findByID?: ReturnType<typeof vi.fn>
  updateGlobal?: ReturnType<typeof vi.fn>
  findGlobal?: ReturnType<typeof vi.fn>
}) {
  return {
    payload: {
      update: overrides?.update ?? vi.fn(),
      findByID: overrides?.findByID ?? vi.fn(),
      updateGlobal: overrides?.updateGlobal ?? vi.fn(),
      findGlobal: overrides?.findGlobal ?? vi.fn(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    context: {},
    user: null,
  }
}

describe('publishDraft post-write validation recovery', () => {
  const draftCollections = new Set(['posts'])

  it('returns success on a clean publish', async () => {
    const tool = createPublishDraftTool(draftCollections)
    const req = buildReq()
    // pre-snapshot read returns prior updatedAt
    req.payload.findByID.mockResolvedValueOnce({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' })
    req.payload.update.mockResolvedValueOnce({ id: 'a', name: 'Hello', _status: 'published' })

    const result = await tool.handler(
      { collection: 'posts', documentId: 'a' },
      req as never,
      {},
    )
    expect(result.content[0]!.text).toMatch(/Successfully published "Hello"/)
  })

  it('downgrades a post-write validation throw to a warning when the live doc reflects THIS attempt (strictly newer updatedAt + _status:published)', async () => {
    const tool = createPublishDraftTool(draftCollections)
    const req = buildReq()
    // pre-snapshot
    req.payload.findByID.mockResolvedValueOnce({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' })
    // update throws (validator fires after version row committed)
    req.payload.update.mockRejectedValueOnce(new Error('Field "breadcrumbs" is invalid'))
    // verify read: strictly newer updatedAt → recovery proceeds
    req.payload.findByID.mockResolvedValueOnce({
      id: 'a',
      name: 'Hello',
      _status: 'published',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })

    const result = await tool.handler(
      { collection: 'posts', documentId: 'a' },
      req as never,
      {},
    )
    const text = result.content[0]!.text
    expect(text).toContain('[publishDraft:published_with_warning]')
    expect(text).toContain('Hello')
    expect(text).toContain('post-write validation error')
    expect(text).toContain('Field "breadcrumbs" is invalid')
  })

  it('surfaces the original error when the live doc reflects a PRIOR publish (same updatedAt)', async () => {
    const tool = createPublishDraftTool(draftCollections)
    const req = buildReq()
    // pre-snapshot at T0
    req.payload.findByID.mockResolvedValueOnce({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' })
    req.payload.update.mockRejectedValueOnce(new Error('Field "breadcrumbs" is invalid'))
    // verify read: SAME updatedAt → stale publish, not the current attempt
    req.payload.findByID.mockResolvedValueOnce({
      id: 'a',
      _status: 'published',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const result = await tool.handler(
      { collection: 'posts', documentId: 'a' },
      req as never,
      {},
    )
    const text = result.content[0]!.text
    expect(text).not.toContain('[publishDraft:published_with_warning]')
    expect(text).toMatch(/Error publishing document a in posts/)
  })

  it('surfaces the original error when the live doc is still in draft after the throw', async () => {
    const tool = createPublishDraftTool(draftCollections)
    const req = buildReq()
    req.payload.findByID.mockResolvedValueOnce({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' })
    req.payload.update.mockRejectedValueOnce(new Error('boom'))
    req.payload.findByID.mockResolvedValueOnce({
      id: 'a',
      _status: 'draft',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })

    const result = await tool.handler(
      { collection: 'posts', documentId: 'a' },
      req as never,
      {},
    )
    expect(result.content[0]!.text).toMatch(/Error publishing document a in posts: boom/)
  })

  it('surfaces the original error when the verify read itself fails (does not mask the real failure)', async () => {
    const tool = createPublishDraftTool(draftCollections)
    const req = buildReq()
    req.payload.findByID.mockResolvedValueOnce({ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' })
    req.payload.update.mockRejectedValueOnce(new Error('publish failed'))
    req.payload.findByID.mockRejectedValueOnce(new Error('access denied'))

    const result = await tool.handler(
      { collection: 'posts', documentId: 'a' },
      req as never,
      {},
    )
    const text = result.content[0]!.text
    expect(text).not.toContain('[publishDraft:published_with_warning]')
    expect(text).toMatch(/Error publishing document a in posts: publish failed/)
  })

  it('surfaces the original error when the pre-snapshot read failed (cannot disambiguate)', async () => {
    const tool = createPublishDraftTool(draftCollections)
    const req = buildReq()
    // pre-snapshot fails
    req.payload.findByID.mockRejectedValueOnce(new Error('snapshot unavailable'))
    req.payload.update.mockRejectedValueOnce(new Error('publish failed'))
    // verify would say "published" but with no baseline we MUST NOT downgrade
    req.payload.findByID.mockResolvedValueOnce({
      id: 'a',
      _status: 'published',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })

    const result = await tool.handler(
      { collection: 'posts', documentId: 'a' },
      req as never,
      {},
    )
    expect(result.content[0]!.text).toMatch(/Error publishing document a in posts: publish failed/)
  })
})

describe('publishGlobalDraft post-write validation recovery', () => {
  it('downgrades to warning when global publish lands despite a validator throw', async () => {
    const tool = createPublishGlobalDraftTool(new Set(['siteSettings']))!
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValueOnce({ updatedAt: '2026-01-01T00:00:00.000Z' })
    req.payload.updateGlobal.mockRejectedValueOnce(new Error('field validation failed'))
    req.payload.findGlobal.mockResolvedValueOnce({
      _status: 'published',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })

    const result = await tool.handler({ slug: 'siteSettings' }, req as never, {})
    const text = result.content[0]!.text
    expect(text).toContain('[publishGlobalDraft:published_with_warning]')
    expect(text).toContain('siteSettings')
    expect(text).toContain('field validation failed')
  })

  it('surfaces original error when the global publish did not advance updatedAt (stale published state)', async () => {
    const tool = createPublishGlobalDraftTool(new Set(['siteSettings']))!
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValueOnce({ updatedAt: '2026-01-01T00:00:00.000Z' })
    req.payload.updateGlobal.mockRejectedValueOnce(new Error('field validation failed'))
    req.payload.findGlobal.mockResolvedValueOnce({
      _status: 'published',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })

    const result = await tool.handler({ slug: 'siteSettings' }, req as never, {})
    expect(result.content[0]!.text).toMatch(/Error publishing global "siteSettings"/)
  })

  it('rejects unknown global slugs at the boundary', async () => {
    const tool = createPublishGlobalDraftTool(new Set(['siteSettings']))!
    const req = buildReq()
    // zod boundary catches before handler body — must not call updateGlobal
    try {
      await tool.handler({ slug: 'unknown' as never }, req as never, {})
    } catch {
      // schema rejection is fine; we only need to confirm no Payload call fired
    }
    expect(req.payload.updateGlobal).not.toHaveBeenCalled()
  })

  it('returns null when no draft-enabled globals exist (skip registration)', () => {
    expect(createPublishGlobalDraftTool(new Set())).toBeNull()
  })
})
