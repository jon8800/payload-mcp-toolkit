import { describe, it, expect } from 'vitest'
import type { Block, CollectionConfig, GlobalConfig } from 'payload'
import {
  introspectCollection,
  introspectCollections,
  introspectBlocks,
  buildBlockNestingMap,
  buildRelationshipGraph,
  hasGlobalDrafts,
  introspectGlobal,
  introspectGlobals,
} from '../introspection'

// ─── Sample schema (kept inline so the test is self-contained) ─────

const Media: CollectionConfig = {
  slug: 'media',
  upload: true,
  fields: [{ name: 'alt', type: 'text', required: true }],
}

const Categories: CollectionConfig = {
  slug: 'categories',
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true },
  ],
}

const Authors: CollectionConfig = {
  slug: 'authors',
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true },
    { name: 'avatar', type: 'upload', relationTo: 'media' },
  ],
}

// Leaf-style blocks
const Heading: Block = {
  slug: 'heading',
  fields: [
    { name: 'text', type: 'text', required: true },
    {
      name: 'level',
      type: 'select',
      options: ['h1', 'h2', 'h3'],
      defaultValue: 'h2',
    },
    {
      name: 'align',
      type: 'select',
      options: ['left', 'center', 'right'],
      defaultValue: 'left',
    },
  ],
}

const RichText: Block = {
  slug: 'richText',
  fields: [{ name: 'content', type: 'richText' }],
}

const ImageBlock: Block = {
  slug: 'image',
  fields: [
    { name: 'image', type: 'upload', relationTo: 'media', required: true },
    { name: 'caption', type: 'text' },
  ],
}

// Container-style blocks (have nested blocks fields)
const FullWidth: Block = {
  slug: 'fullWidth',
  fields: [
    {
      name: 'content',
      type: 'blocks',
      blocks: [Heading, RichText, ImageBlock],
    },
  ],
}

const HeadingOnly: Block = {
  slug: 'headingOnly',
  fields: [
    {
      name: 'content',
      type: 'blocks',
      maxRows: 1,
      blocks: [Heading],
    },
  ],
}

const CtaBanner: Block = {
  slug: 'ctaBanner',
  fields: [
    { name: 'headline', type: 'text', required: true },
    { name: 'buttonLabel', type: 'text' },
    { name: 'buttonHref', type: 'text' },
  ],
}

// Deeply-nestable container — exercises the recursive path
const Accordion: Block = {
  slug: 'accordion',
  fields: [
    {
      name: 'panels',
      type: 'array',
      fields: [
        { name: 'title', type: 'text' },
        {
          name: 'body',
          type: 'blocks',
          blocks: [Heading, RichText, FullWidth],
        },
      ],
    },
  ],
}

const allBlocks: Block[] = [Heading, RichText, ImageBlock, FullWidth, HeadingOnly, CtaBanner, Accordion]

const Posts: CollectionConfig = {
  slug: 'posts',
  versions: { drafts: true },
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true },
    { name: 'featured', type: 'checkbox' },
    { name: 'category', type: 'relationship', relationTo: 'categories' },
    {
      name: 'authors',
      type: 'relationship',
      relationTo: 'authors',
      hasMany: true,
    },
    { name: 'coverImage', type: 'upload', relationTo: 'media' },
    {
      name: 'tags',
      type: 'array',
      fields: [{ name: 'tag', type: 'text' }],
    },
  ],
}

const Pages: CollectionConfig = {
  slug: 'pages',
  versions: { drafts: true },
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          name: 'hero',
          label: 'Hero',
          fields: [
            { name: 'heroTitle', type: 'text' },
            {
              name: 'heroSize',
              type: 'select',
              options: ['small', 'medium', 'large'],
              defaultValue: 'medium',
            },
          ],
        },
        {
          label: 'Content',
          fields: [
            { name: 'slug', type: 'text', required: true },
            { name: 'layout', type: 'blocks', blocks: [FullWidth, HeadingOnly, CtaBanner, Accordion] },
          ],
        },
      ],
    },
  ],
}

// ─── introspectCollection ──────────────────────────────────────────

describe('introspectCollection', () => {
  it('extracts Posts collection fields, relationships, and draft status', () => {
    const schema = introspectCollection(Posts)

    expect(schema.slug).toBe('posts')
    expect(schema.hasDrafts).toBe(true)

    const fieldNames = schema.fields.map((f) => f.name)
    expect(fieldNames).toContain('title')
    expect(fieldNames).toContain('slug')
    expect(fieldNames).toContain('featured')
    expect(fieldNames).toContain('tags')

    const relFieldNames = schema.relationships.map((r) => r.fieldName)
    expect(relFieldNames).toContain('category')
    expect(relFieldNames).toContain('authors')

    const cover = schema.relationships.find((r) => r.fieldName === 'coverImage')
    expect(cover).toBeDefined()
    expect(cover!.relationTo).toBe('media')

    expect(schema.searchableFields).toContain('title')
    expect(schema.searchableFields).toContain('slug')
  })

  it('extracts Pages collection with tab-nested fields', () => {
    const schema = introspectCollection(Pages)

    expect(schema.slug).toBe('pages')
    expect(schema.hasDrafts).toBe(true)

    const fieldNames = schema.fields.map((f) => f.name)
    expect(fieldNames).toContain('heroTitle')
    expect(fieldNames).toContain('slug')
    expect(fieldNames).toContain('layout')
  })

  it('detects collections without draft support', () => {
    const schema = introspectCollection(Categories)
    expect(schema.hasDrafts).toBe(false)
  })

  it('extracts select field options from Pages heroSize', () => {
    const schema = introspectCollection(Pages)
    const heroSize = schema.fields.find((f) => f.name === 'heroSize')
    expect(heroSize).toBeDefined()
    expect(heroSize!.type).toBe('select')
    expect(heroSize!.options).toBeDefined()
    expect(heroSize!.options!.length).toBe(3)
  })
})

// ─── introspectBlocks (flat catalog) ───────────────────────────────

describe('introspectBlocks', () => {
  it('returns a flat catalog of every block with no section/leaf split', () => {
    const catalog = introspectBlocks(allBlocks)
    const slugs = catalog.blocks.map((b) => b.slug)
    expect(slugs).toEqual([
      'heading',
      'richText',
      'image',
      'fullWidth',
      'headingOnly',
      'ctaBanner',
      'accordion',
    ])
  })

  it('extracts each block\'s fields including select options', () => {
    const catalog = introspectBlocks(allBlocks)
    const heading = catalog.blocks.find((b) => b.slug === 'heading')
    expect(heading).toBeDefined()
    const headingFieldNames = heading!.fields.map((f) => f.name)
    expect(headingFieldNames).toEqual(['text', 'level', 'align'])
    const level = heading!.fields.find((f) => f.name === 'level')
    expect(level!.options).toBeDefined()
  })
})

// ─── buildBlockNestingMap ──────────────────────────────────────────

describe('buildBlockNestingMap', () => {
  it('records the layout field on Pages with the slugs it accepts', () => {
    const map = buildBlockNestingMap([Pages, Posts], allBlocks)
    const pageLayout = map.find(
      (e) => e.ownerType === 'collection' && e.owner === 'pages' && e.fieldPath === 'layout',
    )
    expect(pageLayout).toBeDefined()
    expect(pageLayout!.acceptedBlockSlugs).toEqual(['fullWidth', 'headingOnly', 'ctaBanner', 'accordion'])
  })

  it('records nested blocks fields inside container blocks', () => {
    const map = buildBlockNestingMap([Pages], allBlocks)

    const fullWidthContent = map.find(
      (e) => e.ownerType === 'block' && e.owner === 'fullWidth' && e.fieldPath === 'content',
    )
    expect(fullWidthContent).toBeDefined()
    expect(fullWidthContent!.acceptedBlockSlugs).toEqual(['heading', 'richText', 'image'])

    const headingOnly = map.find(
      (e) => e.ownerType === 'block' && e.owner === 'headingOnly' && e.fieldPath === 'content',
    )
    expect(headingOnly!.acceptedBlockSlugs).toEqual(['heading'])
    expect(headingOnly!.maxRows).toBe(1)
  })

  it('handles arbitrarily-deep nesting via array fields inside blocks', () => {
    const map = buildBlockNestingMap([Pages], allBlocks)

    const accordionPanelBody = map.find(
      (e) =>
        e.ownerType === 'block' && e.owner === 'accordion' && e.fieldPath === 'panels[].body',
    )
    expect(accordionPanelBody).toBeDefined()
    expect(accordionPanelBody!.acceptedBlockSlugs).toEqual(['heading', 'richText', 'fullWidth'])
  })

  it('omits unknown slugs not present in the block list', () => {
    const Stray: CollectionConfig = {
      slug: 'stray',
      fields: [
        {
          name: 'layout',
          type: 'blocks',
          blocks: [Heading, { slug: 'mystery', fields: [] } as Block],
        },
      ],
    }
    const map = buildBlockNestingMap([Stray], [Heading]) // mystery not in catalog
    const stray = map.find((e) => e.owner === 'stray' && e.fieldPath === 'layout')
    expect(stray!.acceptedBlockSlugs).toEqual(['heading'])
  })

  it('omits fixed blocks (no nested blocks fields) from the map', () => {
    const map = buildBlockNestingMap([Pages], allBlocks)
    const ctaEntries = map.filter((e) => e.owner === 'ctaBanner')
    expect(ctaEntries).toHaveLength(0)
  })
})

// ─── buildRelationshipGraph ────────────────────────────────────────

// ─── Global introspection ──────────────────────────────────────────

const SiteSettings: GlobalConfig = {
  slug: 'site-settings',
  fields: [
    { name: 'siteName', type: 'text', required: true },
    { name: 'tagline', type: 'text' },
    {
      name: 'social',
      type: 'group',
      fields: [
        { name: 'twitter', type: 'text' },
        { name: 'instagram', type: 'text' },
      ],
    },
  ],
}

const FooterGlobal: GlobalConfig = {
  slug: 'footer',
  versions: { drafts: true },
  fields: [
    {
      name: 'layout',
      type: 'blocks',
      blocks: [Heading, CtaBanner],
    },
  ],
}

const HeaderGlobal: GlobalConfig = {
  slug: 'header',
  fields: [
    {
      name: 'menu',
      type: 'group',
      fields: [
        { name: 'label', type: 'text' },
        {
          name: 'links',
          type: 'blocks',
          blocks: [Heading],
        },
      ],
    },
  ],
}

describe('hasGlobalDrafts', () => {
  it('returns true for { versions: { drafts: true } }', () => {
    expect(hasGlobalDrafts({ slug: 'g', versions: { drafts: true }, fields: [] })).toBe(true)
  })

  it('returns false for { versions: { drafts: false } }', () => {
    expect(hasGlobalDrafts({ slug: 'g', versions: { drafts: false }, fields: [] })).toBe(false)
  })

  it('returns false when versions is undefined', () => {
    expect(hasGlobalDrafts({ slug: 'g', fields: [] })).toBe(false)
  })

  it('returns false for versions without drafts key', () => {
    expect(
      hasGlobalDrafts({ slug: 'g', versions: { maxPerDoc: 10 }, fields: [] } as GlobalConfig),
    ).toBe(false)
  })
})

describe('introspectGlobal', () => {
  it('extracts SiteSettings fields and draft/live-preview flags', () => {
    const schema = introspectGlobal(SiteSettings)
    expect(schema.slug).toBe('site-settings')
    expect(schema.hasDrafts).toBe(false)
    expect(schema.hasLivePreview).toBe(false)
    const names = schema.fields.map((f) => f.name)
    expect(names).toContain('siteName')
    expect(names).toContain('tagline')
    const social = schema.fields.find((f) => f.name === 'social')
    expect(social?.type).toBe('group')
    expect(social?.fields?.map((f) => f.name)).toEqual(['twitter', 'instagram'])
  })

  it('reports hasDrafts: true when versions.drafts is set', () => {
    expect(introspectGlobal(FooterGlobal).hasDrafts).toBe(true)
  })
})

describe('introspectGlobals', () => {
  it('returns an empty Map for []', () => {
    expect(introspectGlobals([]).size).toBe(0)
  })

  it('keys the map by slug', () => {
    const map = introspectGlobals([SiteSettings, FooterGlobal])
    expect(map.has('site-settings')).toBe(true)
    expect(map.has('footer')).toBe(true)
  })
})

describe('buildBlockNestingMap with globals', () => {
  it('emits an edge with ownerType "global" for a top-level blocks field', () => {
    const map = buildBlockNestingMap([], [FooterGlobal], allBlocks)
    const edge = map.find(
      (e) => e.ownerType === 'global' && e.owner === 'footer' && e.fieldPath === 'layout',
    )
    expect(edge).toBeDefined()
    expect(edge!.acceptedBlockSlugs).toEqual(['heading', 'ctaBanner'])
  })

  it('walks group-nested blocks fields under a global with the dotted path', () => {
    const map = buildBlockNestingMap([], [HeaderGlobal], allBlocks)
    const edge = map.find(
      (e) => e.ownerType === 'global' && e.owner === 'header' && e.fieldPath === 'menu.links',
    )
    expect(edge).toBeDefined()
    expect(edge!.acceptedBlockSlugs).toEqual(['heading'])
  })

  it('two-arg call (no globals) produces the same edges as before — regression guard', () => {
    const before = buildBlockNestingMap([Pages], allBlocks)
    const after = buildBlockNestingMap([Pages], [], allBlocks)
    expect(after).toEqual(before)
  })

  it('invariant: throws when (owner, fieldPath) appears with different ownerTypes', () => {
    const ClashCollection: CollectionConfig = {
      slug: 'site-settings',
      fields: [{ name: 'layout', type: 'blocks', blocks: [Heading] }],
    }
    const ClashGlobal: GlobalConfig = {
      slug: 'site-settings',
      fields: [{ name: 'layout', type: 'blocks', blocks: [Heading] }],
    }
    expect(() => buildBlockNestingMap([ClashCollection], [ClashGlobal], [Heading])).toThrow(
      /invariant violated/i,
    )
  })
})

describe('buildRelationshipGraph', () => {
  it('builds correct graph from sample collections', () => {
    const schemas = introspectCollections([Posts, Pages, Categories, Authors, Media])
    const edges = buildRelationshipGraph(schemas)

    const postEdges = edges.filter((e) => e.fromCollection === 'posts')
    const postTargets = postEdges.map((e) => e.toCollection)
    expect(postTargets).toContain('categories')
    expect(postTargets).toContain('authors')
    expect(postTargets).toContain('media')

    const authorEdges = edges.filter((e) => e.fromCollection === 'authors')
    expect(authorEdges.map((e) => e.toCollection)).toContain('media')
  })
})
