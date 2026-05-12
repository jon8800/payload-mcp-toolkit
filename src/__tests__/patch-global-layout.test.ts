import { describe, it, expect, vi } from 'vitest'
import type { Block, GlobalConfig } from 'payload'
import { introspectBlocks, buildBlockNestingMap } from '../introspection'
import { createPatchGlobalLayoutTool } from '../tools/patch-global-layout'

const Heading: Block = { slug: 'heading', fields: [{ name: 'text', type: 'text' }] }
const CtaBanner: Block = { slug: 'ctaBanner', fields: [{ name: 'label', type: 'text' }] }
const Container: Block = {
  slug: 'container',
  fields: [
    {
      name: 'sections',
      type: 'blocks',
      blocks: [Heading, CtaBanner],
    },
  ],
}

const FooterGlobal: GlobalConfig = {
  slug: 'footer',
  versions: { drafts: true },
  fields: [
    {
      name: 'sections',
      type: 'blocks',
      blocks: [Heading, CtaBanner, Container],
    },
  ],
}

const PlainSettings: GlobalConfig = {
  slug: 'plain',
  fields: [{ name: 'siteName', type: 'text' }],
}

function buildReq() {
  return {
    payload: {
      findGlobal: vi.fn(),
      updateGlobal: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    context: {},
    user: null,
  }
}

const allBlocks = [Heading, CtaBanner, Container]
const catalog = introspectBlocks(allBlocks)
const nesting = buildBlockNestingMap([], [FooterGlobal], allBlocks)
const drafts = new Set(['footer'])

describe('patchGlobalLayout', () => {
  it('returns null when no global has a blocks field (factory short-circuit)', () => {
    const emptyNesting = buildBlockNestingMap([], [PlainSettings], allBlocks)
    const tool = createPatchGlobalLayoutTool(catalog, emptyNesting, new Set())
    expect(tool).toBeNull()
  })

  it('registers when at least one global has a blocks field', () => {
    const tool = createPatchGlobalLayoutTool(catalog, nesting, drafts)
    expect(tool).not.toBeNull()
    expect(tool!.name).toBe('patchGlobalLayout')
  })

  it('append: writes existing + new blocks back via updateGlobal', async () => {
    const tool = createPatchGlobalLayoutTool(catalog, nesting, drafts)!
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({
      sections: [{ blockType: 'heading', text: 'a' }],
    })
    req.payload.updateGlobal.mockResolvedValue({})

    await tool.handler(
      {
        slug: 'footer',
        layoutField: 'sections',
        blocks: [{ blockType: 'ctaBanner', label: 'Buy' }],
        operation: 'append',
      },
      req as never,
      {},
    )

    expect(req.payload.updateGlobal).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'footer',
        draft: true,
        data: {
          sections: [
            { blockType: 'heading', text: 'a' },
            { blockType: 'ctaBanner', label: 'Buy' },
          ],
        },
      }),
    )
  })

  it('replaceAt index 0 swaps the first block', async () => {
    const tool = createPatchGlobalLayoutTool(catalog, nesting, drafts)!
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({
      sections: [
        { blockType: 'heading', text: 'a' },
        { blockType: 'ctaBanner', label: 'old' },
      ],
    })
    req.payload.updateGlobal.mockResolvedValue({})

    await tool.handler(
      {
        slug: 'footer',
        layoutField: 'sections',
        blocks: [{ blockType: 'heading', text: 'new-first' }],
        operation: 'replaceAt',
        insertIndex: 0,
      },
      req as never,
      {},
    )

    expect(req.payload.updateGlobal).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          sections: [
            { blockType: 'heading', text: 'new-first' },
            { blockType: 'ctaBanner', label: 'old' },
          ],
        },
      }),
    )
  })

  it('rejects blocks whose slug is not in the field allow-list', async () => {
    const tool = createPatchGlobalLayoutTool(catalog, nesting, drafts)!
    const req = buildReq()
    const result = await tool.handler(
      {
        slug: 'footer',
        layoutField: 'sections',
        // ImageBlock is not in the FooterGlobal allow list.
        blocks: [{ blockType: 'image', src: 'x' }],
        operation: 'full',
      },
      req as never,
      {},
    )
    const text = result.content[0]!.text
    expect(text).toMatch(/unknown blockType/i)
    expect(text).toContain('image')
    expect(req.payload.updateGlobal).not.toHaveBeenCalled()
  })

  it('validates nested blocks fields with breadcrumb path on failure', async () => {
    const tool = createPatchGlobalLayoutTool(catalog, nesting, drafts)!
    const req = buildReq()
    const result = await tool.handler(
      {
        slug: 'footer',
        layoutField: 'sections',
        // Container.sections allows only heading + ctaBanner, but here we shove
        // a non-existent slug to ensure the nested breadcrumb is reported.
        blocks: [
          {
            blockType: 'container',
            sections: [{ blockType: 'mystery', foo: 1 }],
          },
        ],
        operation: 'full',
      },
      req as never,
      {},
    )
    const text = result.content[0]!.text
    expect(text).toMatch(/sections\[0\]\.sections\[0\]/)
    expect(text).toMatch(/mystery/)
    expect(req.payload.updateGlobal).not.toHaveBeenCalled()
  })

  it('returns an error when layoutField is not a blocks field on the global', async () => {
    const tool = createPatchGlobalLayoutTool(catalog, nesting, drafts)!
    const req = buildReq()
    const result = await tool.handler(
      {
        slug: 'footer',
        layoutField: 'definitely-not-a-field',
        blocks: [],
        operation: 'full',
      },
      req as never,
      {},
    )
    expect(result.content[0]!.text).toMatch(/not a blocks-typed field/i)
  })
})
