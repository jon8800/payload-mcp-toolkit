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

  it('dotted layoutField preserves sibling fields in the parent group', async () => {
    // Reg test for the sibling-wipe bug: a dotted layoutField like
    // "sections.layout" used to write {sections: {layout: [...]}} which
    // Payload merges at the top level only — silently wiping
    // sections.copyright. writePath now reads the existing parent group
    // off the fetched global and merges siblings in.
    const NestedFooter: GlobalConfig = {
      slug: 'nestedFooter',
      versions: { drafts: true },
      fields: [
        {
          name: 'sections',
          type: 'group',
          fields: [
            { name: 'copyright', type: 'text' },
            { name: 'layout', type: 'blocks', blocks: [Heading, CtaBanner] },
          ],
        },
      ],
    }
    const nestedNesting = buildBlockNestingMap([], [NestedFooter], allBlocks)
    const tool = createPatchGlobalLayoutTool(catalog, nestedNesting, new Set(['nestedFooter']))!
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({
      sections: {
        copyright: 'do-not-wipe',
        layout: [{ blockType: 'heading', text: 'a' }],
      },
    })
    req.payload.updateGlobal.mockResolvedValue({})

    await tool.handler(
      {
        slug: 'nestedFooter',
        layoutField: 'sections.layout',
        blocks: [{ blockType: 'ctaBanner', label: 'Buy' }],
        operation: 'append',
      },
      req as never,
      {},
    )

    expect(req.payload.updateGlobal).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          sections: {
            copyright: 'do-not-wipe',
            layout: [
              { blockType: 'heading', text: 'a' },
              { blockType: 'ctaBanner', label: 'Buy' },
            ],
          },
        },
      }),
    )
  })

  it('multi-level dotted layoutField preserves siblings at every depth', async () => {
    const DeepFooter: GlobalConfig = {
      slug: 'deepFooter',
      versions: { drafts: true },
      fields: [
        {
          name: 'a',
          type: 'group',
          fields: [
            { name: 'keepA', type: 'text' },
            {
              name: 'b',
              type: 'group',
              fields: [
                { name: 'keepB', type: 'text' },
                { name: 'layout', type: 'blocks', blocks: [Heading] },
              ],
            },
          ],
        },
      ],
    }
    const deepNesting = buildBlockNestingMap([], [DeepFooter], allBlocks)
    const tool = createPatchGlobalLayoutTool(catalog, deepNesting, new Set(['deepFooter']))!
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({
      a: {
        keepA: 'A-survives',
        b: {
          keepB: 'B-survives',
          layout: [],
        },
      },
    })
    req.payload.updateGlobal.mockResolvedValue({})

    await tool.handler(
      {
        slug: 'deepFooter',
        layoutField: 'a.b.layout',
        blocks: [{ blockType: 'heading', text: 'new' }],
        operation: 'full',
      },
      req as never,
      {},
    )

    expect(req.payload.updateGlobal).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          a: {
            keepA: 'A-survives',
            b: {
              keepB: 'B-survives',
              layout: [{ blockType: 'heading', text: 'new' }],
            },
          },
        },
      }),
    )
  })

  it('expectedUpdatedAt mismatch rejects the patch without writing', async () => {
    const tool = createPatchGlobalLayoutTool(catalog, nesting, drafts)!
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({
      sections: [],
      updatedAt: '2026-01-02T00:00:00.000Z',
    })

    const result = await tool.handler(
      {
        slug: 'footer',
        layoutField: 'sections',
        blocks: [{ blockType: 'heading', text: 'a' }],
        operation: 'append',
        expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
      },
      req as never,
      {},
    )

    expect(result.content[0]!.text).toMatch(/conflict/i)
    expect(req.payload.updateGlobal).not.toHaveBeenCalled()
  })

  it('expectedUpdatedAt match proceeds with the patch', async () => {
    const tool = createPatchGlobalLayoutTool(catalog, nesting, drafts)!
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({
      sections: [],
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    req.payload.updateGlobal.mockResolvedValue({})

    await tool.handler(
      {
        slug: 'footer',
        layoutField: 'sections',
        blocks: [{ blockType: 'heading', text: 'a' }],
        operation: 'append',
        expectedUpdatedAt: '2026-01-02T00:00:00.000Z',
      },
      req as never,
      {},
    )

    expect(req.payload.updateGlobal).toHaveBeenCalled()
  })

  it('locale arg is forwarded to findGlobal and updateGlobal', async () => {
    const tool = createPatchGlobalLayoutTool(catalog, nesting, drafts)!
    const req = buildReq()
    req.payload.findGlobal.mockResolvedValue({ sections: [] })
    req.payload.updateGlobal.mockResolvedValue({})

    await tool.handler(
      {
        slug: 'footer',
        layoutField: 'sections',
        blocks: [{ blockType: 'heading', text: 'a' }],
        operation: 'append',
        locale: 'fr',
      },
      req as never,
      {},
    )

    expect(req.payload.findGlobal).toHaveBeenCalledWith(expect.objectContaining({ locale: 'fr' }))
    expect(req.payload.updateGlobal).toHaveBeenCalledWith(expect.objectContaining({ locale: 'fr' }))
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
