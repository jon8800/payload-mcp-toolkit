import { describe, it, expect, vi } from 'vitest'
import { createPublishGlobalDraftTool } from '../tools/publish-global-draft'
import {
  createListGlobalVersionsTool,
  createRestoreGlobalVersionTool,
} from '../tools/global-versions'

function buildReq() {
  return {
    payload: {
      updateGlobal: vi.fn(),
      findGlobalVersions: vi.fn(),
      restoreGlobalVersion: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    context: {},
    user: null,
  }
}

describe('publishGlobalDraft', () => {
  it('returns null when no global has drafts enabled', () => {
    expect(createPublishGlobalDraftTool(new Set())).toBeNull()
  })

  it('promotes the draft to published via updateGlobal', async () => {
    const tool = createPublishGlobalDraftTool(new Set(['footer']))!
    const req = buildReq()
    req.payload.updateGlobal.mockResolvedValue({})

    const result = await tool.handler({ slug: 'footer' }, req as never, {})
    expect(req.payload.updateGlobal).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'footer',
        data: { _status: 'published' },
        overrideAccess: false,
      }),
    )
    expect(result.content[0]!.text).toMatch(/Successfully published global "footer"/)
  })

  it('refuses to publish a global that is not in the draft set', async () => {
    const tool = createPublishGlobalDraftTool(new Set(['footer']))!
    const req = buildReq()
    const result = await tool.handler({ slug: 'other' as never }, req as never, {})
    expect(result.content[0]!.text).toMatch(/does not support drafts/i)
    expect(req.payload.updateGlobal).not.toHaveBeenCalled()
  })

  it('catches Payload errors and returns text error', async () => {
    const tool = createPublishGlobalDraftTool(new Set(['footer']))!
    const req = buildReq()
    req.payload.updateGlobal.mockRejectedValue(new Error('nope'))
    const result = await tool.handler({ slug: 'footer' }, req as never, {})
    expect(result.content[0]!.text).toMatch(/Error publishing global "footer"/)
  })
})

describe('listGlobalVersions', () => {
  it('returns null with no draft globals', () => {
    expect(createListGlobalVersionsTool(new Set())).toBeNull()
  })

  it('returns version metadata newest-first via findGlobalVersions', async () => {
    const tool = createListGlobalVersionsTool(new Set(['footer']))!
    const req = buildReq()
    req.payload.findGlobalVersions.mockResolvedValue({
      totalDocs: 2,
      docs: [
        { id: 'v2', updatedAt: '2026-05-12', createdAt: '2026-05-12', version: { _status: 'draft' } },
        { id: 'v1', updatedAt: '2026-05-11', createdAt: '2026-05-11', version: { _status: 'published' } },
      ],
    })

    const result = await tool.handler({ slug: 'footer', limit: 5 }, req as never, {})
    expect(req.payload.findGlobalVersions).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'footer', sort: '-updatedAt', limit: 5 }),
    )
    const body = JSON.parse(result.content[0]!.text)
    expect(body.versions).toHaveLength(2)
    expect(body.versions[0].id).toBe('v2')
    expect(body.versions[0].status).toBe('draft')
  })
})

describe('restoreGlobalVersion', () => {
  it('returns null with no draft globals', () => {
    expect(createRestoreGlobalVersionTool(new Set())).toBeNull()
  })

  it('calls restoreGlobalVersion and acknowledges the rollback', async () => {
    const tool = createRestoreGlobalVersionTool(new Set(['footer']))!
    const req = buildReq()
    req.payload.restoreGlobalVersion.mockResolvedValue({})

    const result = await tool.handler({ slug: 'footer', versionId: 'v1' }, req as never, {})
    expect(req.payload.restoreGlobalVersion).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'footer', id: 'v1' }),
    )
    expect(result.content[0]!.text).toMatch(/Restored global "footer" from version v1/)
    expect(result.content[0]!.text).toMatch(/publishGlobalDraft/)
  })
})
