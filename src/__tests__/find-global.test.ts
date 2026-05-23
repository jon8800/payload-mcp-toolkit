import { describe, it, expect, vi } from 'vitest'
import type { GlobalConfig } from 'payload'
import { createFindGlobalTool } from '../tools/find-global'
import type { GlobalSchema } from '../types'

const fakeSchema: GlobalSchema = {
  slug: 'site-settings',
  fields: [],
  hasDrafts: true,
  hasLivePreview: false,
}

const draftGlobalConfig: GlobalConfig = {
  slug: 'site-settings',
  admin: {
    livePreview: {
      url: ({ data }: { data: Record<string, unknown> }) =>
        `/preview/globals/site-settings?v=${data.siteName ?? ''}`,
    },
  } as never,
  fields: [],
  versions: { drafts: true },
}

function buildReq() {
  return {
    payload: {
      findGlobal: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    context: {},
    user: null,
  }
}

describe('findGlobal', () => {
  const schemas = new Map([['site-settings', fakeSchema]])
  const drafts = new Set(['site-settings'])
  const configs = new Map([['site-settings', draftGlobalConfig]])

  it('calls findGlobal with overrideAccess:false', async () => {
    const tool = createFindGlobalTool(schemas, drafts, configs, 'https://app.example.com')
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({ siteName: 'Acme', _status: 'published' })

    const result = await tool.handler({ slug: 'site-settings' }, req as never, {})
    expect(req.payload.findGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'site-settings', overrideAccess: false, draft: false }),
    )
    expect(result.content[0]!.text).toContain('"siteName":"Acme"')
  })

  it('passes draft:true through when requested', async () => {
    const tool = createFindGlobalTool(schemas, drafts, configs, undefined)
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({ siteName: 'draft', _status: 'draft' })

    await tool.handler({ slug: 'site-settings', draft: true }, req as never, {})
    expect(req.payload.findGlobal).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'site-settings', draft: true }),
    )
  })

  it('stamps a preview URL when the draft global has livePreview configured', async () => {
    const tool = createFindGlobalTool(schemas, drafts, configs, 'https://app.example.com')
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({ siteName: 'Acme', _status: 'draft' })

    const result = await tool.handler({ slug: 'site-settings', draft: true }, req as never, {})
    const allText = result.content.map((c) => c.text).join('\n')
    expect(allText).toContain('https://app.example.com/preview/globals/site-settings?v=Acme')
  })

  it('falls back to admin-panel hint when global has no preview function', async () => {
    const noPreview: GlobalConfig = { slug: 'site-settings', fields: [] }
    const tool = createFindGlobalTool(
      schemas,
      drafts,
      new Map([['site-settings', noPreview]]),
      undefined,
    )
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({ siteName: 'Acme', _status: 'draft' })

    const result = await tool.handler({ slug: 'site-settings', draft: true }, req as never, {})
    const allText = result.content.map((c) => c.text).join('\n')
    expect(allText).toMatch(/admin panel/i)
  })

  it('omits preview decoration entirely when previewDisabled is true', async () => {
    const tool = createFindGlobalTool(schemas, drafts, configs, 'https://app.example.com', true)
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({ siteName: 'Acme', _status: 'draft' })

    const result = await tool.handler({ slug: 'site-settings', draft: true }, req as never, {})
    expect(result.content).toHaveLength(1)
  })

  it('returns text error when the global slug is unknown', async () => {
    const tool = createFindGlobalTool(schemas, drafts, configs, undefined)
    const req = buildReq()
    const result = await tool.handler({ slug: 'no-such-global' as never }, req as never, {})
    expect(result.content[0]!.text).toMatch(/Unknown global/)
  })

  it('catches errors and returns text error response, no exception', async () => {
    const tool = createFindGlobalTool(schemas, drafts, configs, undefined)
    const req = buildReq()
    req.payload.findGlobal.mockRejectedValue(new Error('boom'))
    const result = await tool.handler({ slug: 'site-settings' }, req as never, {})
    expect(result.content[0]!.text).toMatch(/Error reading global/)
  })

  it('slug enum errorMap surfaces friendly "unknown or excluded" message', () => {
    const tool = createFindGlobalTool(schemas, drafts, configs, undefined)
    const slugParam = tool.parameters.slug as { safeParse: (v: unknown) => { success: boolean; error?: { issues: Array<{ message: string }> } } }
    const res = slugParam.safeParse('secret-config')
    expect(res.success).toBe(false)
    expect(res.error!.issues[0]!.message).toMatch(/Unknown or excluded/)
    expect(res.error!.issues[0]!.message).toContain('site-settings')
  })

  it('does not stamp preview for a published doc even when livePreview is set', async () => {
    const tool = createFindGlobalTool(schemas, drafts, configs, 'https://app.example.com')
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({ siteName: 'Acme', _status: 'published' })

    const result = await tool.handler({ slug: 'site-settings' }, req as never, {})
    expect(result.content).toHaveLength(1)
  })
})
