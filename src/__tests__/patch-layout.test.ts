import { describe, it, expect, vi } from 'vitest'
import type { Block, CollectionConfig } from 'payload'
import { introspectBlocks, buildBlockNestingMap } from '../introspection'
import { createPatchLayoutTool } from '../tools/patch-layout'

const Heading: Block = { slug: 'heading', fields: [{ name: 'text', type: 'text' }] }
const CtaBanner: Block = { slug: 'ctaBanner', fields: [{ name: 'label', type: 'text' }] }

const Pages: CollectionConfig = {
  slug: 'pages',
  versions: { drafts: true },
  fields: [
    {
      name: 'layout',
      type: 'blocks',
      blocks: [Heading, CtaBanner],
    },
  ],
}

function buildReq() {
  return {
    payload: {
      findByID: vi.fn(),
      update: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
    context: {},
    user: null,
  }
}

const allBlocks = [Heading, CtaBanner]
const catalog = introspectBlocks(allBlocks)
const nesting = buildBlockNestingMap([Pages], [], allBlocks)
const drafts = new Set(['pages'])

describe('patchLayout', () => {
  it('flat layoutField writes {[layoutField]: finalLayout} — no regression from shared writePath', async () => {
    // After extracting writePath into _layout-helpers, the collection tool
    // doesn't itself use writePath, but this is the canonical regression
    // check that the flat-path shape stays a single top-level key so
    // Payload's `update` merges normally.
    const tool = createPatchLayoutTool(catalog, nesting, drafts)
    const req = buildReq()
    req.payload.findByID.mockResolvedValue({
      id: '1',
      layout: [{ blockType: 'heading', text: 'a' }],
    })
    req.payload.update.mockResolvedValue({ id: '1', title: 'p' })

    await tool.handler(
      {
        collection: 'pages',
        documentId: '1',
        layoutField: 'layout',
        blocks: [{ blockType: 'ctaBanner', label: 'Buy' }],
        operation: 'append',
      },
      req as never,
      {},
    )

    expect(req.payload.update).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'pages',
        id: '1',
        data: {
          layout: [
            { blockType: 'heading', text: 'a' },
            { blockType: 'ctaBanner', label: 'Buy' },
          ],
        },
      }),
    )
  })

  it('full operation replaces the array wholesale', async () => {
    const tool = createPatchLayoutTool(catalog, nesting, drafts)
    const req = buildReq()
    req.payload.findByID.mockResolvedValue({
      id: '1',
      layout: [{ blockType: 'heading', text: 'old' }],
    })
    req.payload.update.mockResolvedValue({ id: '1' })

    await tool.handler(
      {
        collection: 'pages',
        documentId: '1',
        layoutField: 'layout',
        blocks: [{ blockType: 'heading', text: 'new' }],
        operation: 'full',
      },
      req as never,
      {},
    )

    expect(req.payload.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { layout: [{ blockType: 'heading', text: 'new' }] },
      }),
    )
  })

  it('rejects unknown blockType with validation error', async () => {
    const tool = createPatchLayoutTool(catalog, nesting, drafts)
    const req = buildReq()
    const result = await tool.handler(
      {
        collection: 'pages',
        documentId: '1',
        layoutField: 'layout',
        blocks: [{ blockType: 'mystery' }],
        operation: 'full',
      },
      req as never,
      {},
    )
    expect(result.content[0]!.text).toMatch(/unknown blockType/i)
    expect(req.payload.update).not.toHaveBeenCalled()
  })
})
