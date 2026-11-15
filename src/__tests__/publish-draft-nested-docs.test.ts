import { afterAll, beforeAll, expect, it } from 'vitest'
import { buildConfig, getPayload, type Payload, type PayloadRequest } from 'payload'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { nestedDocsPlugin } from '@payloadcms/plugin-nested-docs'
import { createPublishDraftTool } from '../tools/publish-draft.js'

let payload: Payload
let user: PayloadRequest['user']

beforeAll(async () => {
  payload = await getPayload({
    config: buildConfig({
      secret: 'nested-docs-publish-secret',
      db: sqliteAdapter({ client: { url: 'file::memory:' }, push: true }),
      typescript: { autoGenerate: false },
      collections: [
        { slug: 'users', auth: true, fields: [] },
        {
          slug: 'pages',
          admin: { useAsTitle: 'title' },
          access: { read: () => true, create: () => true, update: () => true },
          versions: { drafts: { autosave: { interval: 375 } }, maxPerDoc: 25 },
          fields: [
            { name: 'title', type: 'text', required: true },
            { name: 'slug', type: 'text' },
          ],
        },
      ],
      plugins: [
        nestedDocsPlugin({
          collections: ['pages'],
          generateLabel: (_, doc) => String(doc.title ?? ''),
          generateURL: (docs) => docs.reduce((url, doc) => `${url}/${String(doc.slug ?? '')}`, ''),
        }),
      ],
    }),
  })
  const created = await payload.create({
    collection: 'users',
    data: { email: 'nested@example.com', password: 'integration-password-1!' },
  })
  user = { ...created, collection: 'users' } as PayloadRequest['user']
})

afterAll(async () => {
  await payload?.destroy()
  ;(payload?.db as unknown as { client?: { close: () => void } })?.client?.close()
})

function mcpReq(): PayloadRequest {
  return { payload, user, context: {}, payloadDataLoader: undefined } as unknown as PayloadRequest
}

it('publishes a nested-docs draft child (breadcrumbs) the same way the admin UI does', async () => {
  const parent = await payload.create({
    collection: 'pages',
    data: { title: 'Services', slug: 'services', _status: 'published' } as never,
  })
  const child = await payload.create({
    collection: 'pages',
    draft: true,
    data: { title: 'Dinner dates', slug: 'dinner-dates', parent: parent.id, _status: 'draft' } as never,
  })
  await payload.update({
    collection: 'pages',
    id: child.id,
    draft: true,
    data: { title: 'Dinner dates and more' } as never,
  })

  const tool = createPublishDraftTool(new Set(['pages']))
  const result = await tool.handler({ collection: 'pages', documentId: String(child.id) }, mcpReq(), {})
  const text = result.content[0]!.text
  expect(text).toMatch(/^Successfully published "Dinner dates and more"/)

  const live = (await payload.findByID({ collection: 'pages', id: child.id, draft: false, depth: 0 })) as unknown as {
    _status: string
    title: string
    breadcrumbs: Array<{ doc: unknown; url: string }>
  }
  expect(live._status).toBe('published')
  expect(live.title).toBe('Dinner dates and more')
  expect(live.breadcrumbs.map((b) => b.url)).toEqual(['/services', '/services/dinner-dates'])
  expect(live.breadcrumbs.map((b) => b.doc)).toEqual([parent.id, child.id])
})
