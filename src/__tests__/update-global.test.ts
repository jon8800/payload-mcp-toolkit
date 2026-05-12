import { describe, it, expect, vi } from 'vitest'
import { createUpdateGlobalTool } from '../tools/update-global'
import type { GlobalSchema } from '../types'

const siteSettings: GlobalSchema = {
  slug: 'site-settings',
  fields: [
    { name: 'siteName', type: 'text' },
    { name: 'tagline', type: 'text' },
  ],
  hasDrafts: false,
  hasLivePreview: false,
}

const footer: GlobalSchema = {
  slug: 'footer',
  fields: [{ name: 'copyright', type: 'text' }],
  hasDrafts: true,
  hasLivePreview: false,
}

function buildReq() {
  return {
    payload: {
      updateGlobal: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    context: {},
    user: null,
  }
}

describe('updateGlobal', () => {
  const schemas = new Map([
    ['site-settings', siteSettings],
    ['footer', footer],
  ])
  const drafts = new Set(['footer'])

  it('partial-merges only the supplied fields', async () => {
    const tool = createUpdateGlobalTool(schemas, drafts)
    const req = buildReq()
    req.payload.updateGlobal.mockResolvedValue({ siteName: 'Acme' })

    const result = await tool.handler(
      { slug: 'site-settings', data: '{"siteName":"Acme"}' },
      req as never,
      {},
    )
    expect(req.payload.updateGlobal).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'site-settings',
        data: { siteName: 'Acme' },
        overrideAccess: false,
      }),
    )
    expect(result.content[0]!.text).toMatch(/Changed fields: siteName/)
  })

  it('passes draft:true for draft-enabled globals (always-draft default)', async () => {
    const tool = createUpdateGlobalTool(schemas, drafts)
    const req = buildReq()
    req.payload.updateGlobal.mockResolvedValue({ copyright: '© 2026' })

    await tool.handler({ slug: 'footer', data: '{"copyright":"© 2026"}' }, req as never, {})
    expect(req.payload.updateGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'footer', draft: true }),
    )
  })

  it('passes draft:false for non-draft globals', async () => {
    const tool = createUpdateGlobalTool(schemas, drafts)
    const req = buildReq()
    req.payload.updateGlobal.mockResolvedValue({ siteName: 'Acme' })

    await tool.handler({ slug: 'site-settings', data: '{"siteName":"Acme"}' }, req as never, {})
    expect(req.payload.updateGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'site-settings', draft: false }),
    )
  })

  it('returns text error on malformed JSON', async () => {
    const tool = createUpdateGlobalTool(schemas, drafts)
    const req = buildReq()
    const result = await tool.handler(
      { slug: 'site-settings', data: 'not-json' },
      req as never,
      {},
    )
    expect(result.content[0]!.text).toMatch(/must be a valid JSON/)
    expect(req.payload.updateGlobal).not.toHaveBeenCalled()
  })

  it('returns text error when slug is unknown', async () => {
    const tool = createUpdateGlobalTool(schemas, drafts)
    const req = buildReq()
    const result = await tool.handler(
      { slug: 'no-such-global' as never, data: '{"x":1}' },
      req as never,
      {},
    )
    expect(result.content[0]!.text).toMatch(/Unknown global/)
  })

  it('rejects empty data objects', async () => {
    const tool = createUpdateGlobalTool(schemas, drafts)
    const req = buildReq()
    const result = await tool.handler(
      { slug: 'site-settings', data: '{}' },
      req as never,
      {},
    )
    expect(result.content[0]!.text).toMatch(/No fields provided/)
    expect(req.payload.updateGlobal).not.toHaveBeenCalled()
  })

  it('catches Payload errors and returns text error response', async () => {
    const tool = createUpdateGlobalTool(schemas, drafts)
    const req = buildReq()
    req.payload.updateGlobal.mockRejectedValue(new Error('validation failed'))

    const result = await tool.handler(
      { slug: 'site-settings', data: '{"siteName":"X"}' },
      req as never,
      {},
    )
    expect(result.content[0]!.text).toMatch(/Error updating global "site-settings"/)
  })

  it('mentions the draft note in the response for draft-enabled globals', async () => {
    const tool = createUpdateGlobalTool(schemas, drafts)
    const req = buildReq()
    req.payload.updateGlobal.mockResolvedValue({})

    const result = await tool.handler(
      { slug: 'footer', data: '{"copyright":"x"}' },
      req as never,
      {},
    )
    expect(result.content[0]!.text).toMatch(/draft/i)
  })
})
