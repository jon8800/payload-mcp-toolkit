import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildConfig, getPayload, type CollectionConfig, type Payload, type PayloadRequest } from 'payload'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { createFindDocumentTool } from '../tools/find-document.js'
import { createFindGlobalTool } from '../tools/find-global.js'
import { createListGlobalVersionsTool } from '../tools/global-versions.js'
import { createListVersionsTool } from '../tools/versions.js'
import { createSearchContentTool } from '../tools/search-content.js'
import { createResolveReferenceTool } from '../tools/resolve-reference.js'
import { toSelect } from '../tools/_helpers.js'
import type { CollectionSchema, GlobalSchema } from '../types.js'

const open = { read: () => true, create: () => true, update: () => true, readVersions: () => true }
const pages: CollectionConfig = {
  slug: 'pages',
  admin: { useAsTitle: 'heading' },
  access: open,
  versions: { drafts: true },
  fields: [
    { name: 'heading', type: 'text' },
    { name: 'slug', type: 'text' },
    { name: 'image', type: 'upload', relationTo: 'media' },
    { name: 'meta', type: 'group', fields: [{ name: 'description', type: 'text' }, { name: 'keywords', type: 'text' }] },
    { name: 'layout', type: 'blocks', blocks: [{ slug: 'hero', fields: [{ name: 'text', type: 'textarea' }] }] },
  ],
}
const media: CollectionConfig = {
  slug: 'media',
  access: open,
  upload: { staticDir: 'media', imageSizes: [{ name: 'thumb', width: 10 }, { name: 'card', width: 20 }] },
  fields: [{ name: 'alt', type: 'text' }],
}

let payload: Payload
let pageId: number
const bigText = 'x'.repeat(30_000)

function req(): PayloadRequest {
  return { payload, user: null, context: {} } as unknown as PayloadRequest
}
function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text)
}

beforeAll(async () => {
  payload = await getPayload({
    config: buildConfig({
      secret: 'read-select-secret',
      db: sqliteAdapter({ client: { url: 'file::memory:' }, push: true }),
      typescript: { autoGenerate: false },
      collections: [{ slug: 'users', auth: true, fields: [] }, media, pages],
      globals: [
        {
          slug: 'settings',
          access: { read: () => true, update: () => true, readVersions: () => true },
          versions: { drafts: true },
          fields: [{ name: 'siteName', type: 'text' }, { name: 'footer', type: 'textarea' }, { name: 'logo', type: 'upload', relationTo: 'media' }],
        },
      ],
    }),
  })
  const image = await payload.db.create({
    collection: 'media',
    data: { alt: 'Hero', filename: 'hero.png', sizes: { thumb: { filename: 't.png', width: 10 }, card: { filename: 'c.png', width: 20 } } },
  })
  const page = await payload.create({
    collection: 'pages',
    data: {
      heading: 'Home', slug: 'home', image: image.id, meta: { description: 'Welcome', keywords: 'k' },
      layout: [{ blockType: 'hero', text: bigText }], _status: 'published',
    } as never,
  })
  pageId = page.id as number
  await payload.update({ collection: 'pages', id: pageId, draft: true, data: { heading: 'Home (draft)' } as never })
  await payload.updateGlobal({ slug: 'settings', data: { siteName: 'Ruby', footer: bigText, logo: image.id, _status: 'published' } as never })
})

afterAll(async () => {
  await payload?.destroy()
  ;(payload?.db as unknown as { client?: { close: () => void } })?.client?.close()
})

const schema = { slug: 'pages', fields: [], hasDrafts: true, hasLivePreview: false, relationships: [], searchableFields: ['heading', 'slug'] } as CollectionSchema
const findDocument = createFindDocumentTool(new Map([['pages', schema]]), new Set(['pages']), new Map([['pages', pages]]), undefined, true)

describe('select and lean defaults on read tools', () => {
  it('turns field paths into Payload select, letting a parent path win', () => {
    expect(toSelect(['title', 'meta.description', 'meta.keywords'])).toEqual({ title: true, meta: { description: true, keywords: true } })
    expect(toSelect(['meta.description', 'meta'])).toEqual({ meta: true })
    expect(toSelect(['meta', 'meta.description'])).toEqual({ meta: true })
    expect(toSelect([])).toBeUndefined()
  })

  it('lists summary fields at depth 0 by default, with a note on how to get more', async () => {
    const body = parse(await findDocument.handler({ collection: 'pages' }, req(), {}))
    expect(Object.keys(body.docs[0]).sort()).toEqual(['_status', 'heading', 'id', 'slug', 'updatedAt'])
    expect(body.note).toContain('`select`')
    expect(JSON.stringify(body).length).toBeLessThan(1_000)
  })

  it('lists whole documents with full: true and chosen fields with select', async () => {
    const full = parse(await findDocument.handler({ collection: 'pages', full: true }, req(), {}))
    expect(full.docs[0].layout[0].text).toBe(bigText)
    expect(typeof full.docs[0].image).toBe('number')
    expect(full.note).toBeUndefined()

    const chosen = parse(await findDocument.handler({ collection: 'pages', select: ['meta.description'] }, req(), {}))
    expect(chosen.docs[0]).toEqual({ id: pageId, meta: { description: 'Welcome' } })
  })

  it('reads a single document complete at depth 1, with linked uploads trimmed of image sizes', async () => {
    const doc = parse(await findDocument.handler({ collection: 'pages', documentId: String(pageId) }, req(), {}))
    expect(doc.layout[0].text).toBe(bigText)
    expect(doc.image).toMatchObject({ alt: 'Hero', filename: 'hero.png' })
    expect(doc.image.sizes).toBeUndefined()

    const withSizes = parse(await findDocument.handler({ collection: 'pages', documentId: String(pageId), full: true }, req(), {}))
    expect(Object.keys(withSizes.image.sizes).sort()).toEqual(['card', 'thumb'])
  })

  it('respects a passed depth and select on draft reads', async () => {
    const draft = parse(await findDocument.handler(
      { collection: 'pages', documentId: String(pageId), draft: true, depth: 0, select: ['heading', 'image'] }, req(), {},
    ))
    expect(draft).toEqual({ id: pageId, heading: 'Home (draft)', image: expect.any(Number) })

    const list = parse(await findDocument.handler({ collection: 'pages', draft: true, depth: 1, select: ['image'] }, req(), {}))
    expect(list.docs[0].image).toMatchObject({ alt: 'Hero' })
  })

  it('selects global fields and trims linked uploads', async () => {
    const globalSchema = { slug: 'settings', fields: [], hasDrafts: true, hasLivePreview: false } as GlobalSchema
    const findGlobal = createFindGlobalTool(new Map([['settings', globalSchema]]), new Set(['settings']), new Map(), undefined, true)
    expect(parse(await findGlobal.handler({ slug: 'settings', select: ['siteName'] }, req(), {}))).toMatchObject({ siteName: 'Ruby' })
    expect(parse(await findGlobal.handler({ slug: 'settings', select: ['siteName'] }, req(), {})).footer).toBeUndefined()
    const whole = parse(await findGlobal.handler({ slug: 'settings' }, req(), {}))
    expect(whole.footer).toBe(bigText)
    expect(whole.logo.sizes).toBeUndefined()
  })

  it('lists versions with only summary data, plus selected fields when asked', async () => {
    const listVersions = createListVersionsTool(new Set(['pages']))
    const plain = parse(await listVersions.handler({ collection: 'pages', documentId: String(pageId) }, req(), {}))
    expect(plain.versions.map((v: { displayName: string }) => v.displayName)).toEqual(['home', 'home'])
    expect(plain.versions.map((v: { status: string }) => v.status)).toEqual(['draft', 'published'])
    expect(plain.versions[0].fields).toBeUndefined()
    const chosen = parse(await listVersions.handler({ collection: 'pages', documentId: String(pageId), select: ['meta.description'] }, req(), {}))
    expect(chosen.versions[0].fields).toEqual({ 'meta.description': 'Welcome' })
    expect(JSON.stringify(chosen)).not.toContain(bigText)

    const listGlobalVersions = createListGlobalVersionsTool(new Set(['settings']))!
    const globals = parse(await listGlobalVersions.handler({ slug: 'settings', select: ['siteName'] }, req(), {}))
    expect(globals.versions[0].fields).toEqual({ siteName: 'Ruby' })
    expect(JSON.stringify(globals)).not.toContain(bigText)
  })

  it('adds selected fields to search and resolve hits', async () => {
    const search = createSearchContentTool(new Map([['pages', schema]]))
    const hits = parse(await search.handler({ query: 'home', select: ['meta.description'] }, req(), {}))
    expect(hits.hits.pages[0]).toMatchObject({ id: pageId, fields: { 'meta.description': 'Welcome' } })
    expect(JSON.stringify(hits)).not.toContain(bigText)

    const resolve = createResolveReferenceTool(new Map([['pages', ['heading', 'slug']]]))
    const found = parse(await resolve.handler({ query: 'home', select: ['meta.description'] }, req()))
    expect(found.candidates.pages[0]).toMatchObject({ id: pageId, matchType: 'exact-slug', fields: { 'meta.description': 'Welcome' } })
  })
})
