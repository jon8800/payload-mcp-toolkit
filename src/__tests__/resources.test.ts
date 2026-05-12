import { describe, it, expect } from 'vitest'
import type { Block, CollectionConfig, GlobalConfig } from 'payload'
import {
  introspectCollections,
  introspectGlobals,
  introspectBlocks,
  buildBlockNestingMap,
  buildRelationshipGraph,
} from '../introspection'
import { generateResources } from '../resources'

const Heading: Block = {
  slug: 'heading',
  fields: [{ name: 'text', type: 'text' }],
}

const Pages: CollectionConfig = {
  slug: 'pages',
  fields: [
    { name: 'slug', type: 'text' },
    { name: 'layout', type: 'blocks', blocks: [Heading] },
  ],
}

const SiteSettings: GlobalConfig = {
  slug: 'site-settings',
  fields: [
    { name: 'siteName', type: 'text', required: true },
    { name: 'tagline', type: 'text' },
  ],
}

const FooterGlobal: GlobalConfig = {
  slug: 'footer',
  fields: [{ name: 'links', type: 'blocks', blocks: [Heading] }],
}

function build(globals: GlobalConfig[] = []) {
  const collectionSchemas = introspectCollections([Pages])
  const globalSchemas = introspectGlobals(globals)
  const catalog = introspectBlocks([Heading])
  const nesting = buildBlockNestingMap([Pages], globals, [Heading])
  const relationships = buildRelationshipGraph(collectionSchemas)
  return generateResources(collectionSchemas, catalog, nesting, relationships, globalSchemas)
}

function bodyOf(resource: ReturnType<typeof generateResources>[number]): unknown {
  const result = resource.handler(new URL(resource.uri))
  const text = (result as { contents: Array<{ text: string }> }).contents[0].text
  return JSON.parse(text)
}

describe('generateResources — globals', () => {
  it('omits globals://schema when no globals are registered', () => {
    const resources = build([])
    expect(resources.find((r) => r.uri === 'globals://schema')).toBeUndefined()
  })

  it('emits globals://schema when at least one global is registered', () => {
    const resources = build([SiteSettings])
    const res = resources.find((r) => r.uri === 'globals://schema')
    expect(res).toBeDefined()
    const body = bodyOf(res!) as Record<string, { slug: string; hasDrafts: boolean }>
    expect(Object.keys(body)).toEqual(['site-settings'])
    expect(body['site-settings'].hasDrafts).toBe(false)
  })

  it('globals://schema body lists every supplied global', () => {
    const resources = build([SiteSettings, FooterGlobal])
    const body = bodyOf(resources.find((r) => r.uri === 'globals://schema')!) as Record<
      string,
      unknown
    >
    expect(new Set(Object.keys(body))).toEqual(new Set(['site-settings', 'footer']))
  })

  it('blocks://nesting includes global-owned edges when a global has a blocks field', () => {
    const resources = build([FooterGlobal])
    const nesting = bodyOf(resources.find((r) => r.uri === 'blocks://nesting')!) as Array<{
      owner: string
      ownerType: string
      fieldPath: string
    }>
    const edge = nesting.find(
      (e) => e.ownerType === 'global' && e.owner === 'footer' && e.fieldPath === 'links',
    )
    expect(edge).toBeDefined()

    // Existing collection-owned edges still present
    const pageLayout = nesting.find(
      (e) => e.ownerType === 'collection' && e.owner === 'pages' && e.fieldPath === 'layout',
    )
    expect(pageLayout).toBeDefined()
  })

  it('back-compat: omitting the globalSchemas arg still produces the four legacy resources', () => {
    const collectionSchemas = introspectCollections([Pages])
    const catalog = introspectBlocks([Heading])
    const nesting = buildBlockNestingMap([Pages], [], [Heading])
    const relationships = buildRelationshipGraph(collectionSchemas)
    const resources = generateResources(collectionSchemas, catalog, nesting, relationships)
    const uris = resources.map((r) => r.uri)
    expect(uris).toEqual([
      'blocks://catalog',
      'blocks://nesting',
      'collections://schema',
      'collections://relationships',
    ])
  })
})
