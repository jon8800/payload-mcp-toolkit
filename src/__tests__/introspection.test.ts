import { describe, it, expect } from 'vitest'
import type { Block, CollectionConfig } from 'payload'
import {
  introspectCollection,
  introspectCollections,
  introspectBlocks,
  buildRelationshipGraph,
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

// Leaf blocks
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

const allLeafBlocks: Block[] = [Heading, RichText, ImageBlock]

// Section blocks
const FullWidth: Block = {
  slug: 'fullWidth',
  fields: [
    {
      name: 'content',
      type: 'blocks',
      blocks: allLeafBlocks,
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

const allSectionBlocks: Block[] = [FullWidth, HeadingOnly, CtaBanner]

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
            { name: 'layout', type: 'blocks', blocks: allSectionBlocks },
          ],
        },
      ],
    },
  ],
}

// ─── Tests ─────────────────────────────────────────────────────────

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

describe('introspectBlocks', () => {
  it('discovers fullWidth accepts all leaf blocks (composable)', () => {
    const catalog = introspectBlocks(allSectionBlocks, allLeafBlocks)

    const fullWidth = catalog.sections.find((s) => s.slug === 'fullWidth')
    expect(fullWidth).toBeDefined()
    expect(fullWidth!.nestingType).toBe('composable')
    expect(fullWidth!.acceptedLeafSlugs.length).toBe(allLeafBlocks.length)
  })

  it('marks ctaBanner as fixed (no nested blocks)', () => {
    const catalog = introspectBlocks(allSectionBlocks, allLeafBlocks)

    const ctaBanner = catalog.sections.find((s) => s.slug === 'ctaBanner')
    expect(ctaBanner).toBeDefined()
    expect(ctaBanner!.nestingType).toBe('fixed')
    expect(ctaBanner!.acceptedLeafSlugs).toHaveLength(0)
  })

  it('marks headingOnly as constrained (single leaf type, maxRows: 1)', () => {
    const catalog = introspectBlocks(allSectionBlocks, allLeafBlocks)

    const headingOnly = catalog.sections.find((s) => s.slug === 'headingOnly')
    expect(headingOnly).toBeDefined()
    expect(headingOnly!.nestingType).toBe('constrained')
    expect(headingOnly!.acceptedLeafSlugs).toEqual(['heading'])
    expect(headingOnly!.maxRows).toBe(1)
  })

  it('extracts all leaf blocks', () => {
    const catalog = introspectBlocks(allSectionBlocks, allLeafBlocks)
    expect(catalog.leaves).toHaveLength(3)
    const leafSlugs = catalog.leaves.map((l) => l.slug)
    expect(leafSlugs).toEqual(['heading', 'richText', 'image'])
  })

  it('extracts leaf block fields including select options', () => {
    const catalog = introspectBlocks(allSectionBlocks, allLeafBlocks)
    const heading = catalog.leaves.find((l) => l.slug === 'heading')
    expect(heading).toBeDefined()
    const headingFieldNames = heading!.fields.map((f) => f.name)
    expect(headingFieldNames).toEqual(['text', 'level', 'align'])
    const level = heading!.fields.find((f) => f.name === 'level')
    expect(level!.options).toBeDefined()
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
