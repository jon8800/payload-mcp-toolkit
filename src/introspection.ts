import type { Block, CollectionConfig, Field } from 'payload'
import type {
  BlockCatalog,
  BlockNestingMap,
  BlockSchema,
  CollectionSchema,
  FieldSchema,
  RelationshipEdge,
} from './types'

/**
 * True if the collection has Payload drafts enabled in its versions config.
 */
export function hasCollectionDrafts(collection: CollectionConfig): boolean {
  const versions = collection.versions
  return (
    typeof versions === 'object' &&
    versions !== null &&
    'drafts' in versions &&
    Boolean(versions.drafts)
  )
}

/**
 * Introspect a Payload collection config into structured metadata.
 */
export function introspectCollection(collection: CollectionConfig): CollectionSchema {
  const fields = extractFields(collection.fields)
  const relationships = extractRelationships(collection.fields)
  const searchableFields = fields
    .filter((f) => ['text', 'email'].includes(f.type) && ['name', 'title', 'slug'].includes(f.name))
    .map((f) => f.name)

  const hasLivePreview = !!(
    collection.admin &&
    typeof collection.admin === 'object' &&
    'livePreview' in collection.admin &&
    collection.admin.livePreview
  )

  return {
    slug: collection.slug,
    fields,
    hasDrafts: hasCollectionDrafts(collection),
    hasLivePreview,
    relationships,
    searchableFields,
  }
}

/**
 * Introspect all collections into a map keyed by slug.
 */
export function introspectCollections(
  collections: CollectionConfig[],
): Map<string, CollectionSchema> {
  const map = new Map<string, CollectionSchema>()
  for (const collection of collections) {
    map.set(collection.slug, introspectCollection(collection))
  }
  return map
}

/**
 * Build a flat catalog of every block in the schema. Whether a block can
 * nest other blocks is represented separately in the BlockNestingMap, not
 * as a section/leaf classification — the AI reads both and composes
 * arbitrarily-nested layouts from there.
 */
export function introspectBlocks(blocks: Block[]): BlockCatalog {
  const catalog: BlockSchema[] = blocks.map((block) => ({
    slug: block.slug,
    fields: extractFields(block.fields),
  }))
  return { blocks: catalog }
}

/**
 * Walk every collection and every block, recording each `blocks`-typed
 * field's owner, dotted path, and accepted slugs.
 *
 * The AI uses this to compose layouts at any depth: it looks up which
 * slugs the relevant field accepts, picks one, then if that block has
 * its own `blocks` fields it recurses against the same map.
 */
export function buildBlockNestingMap(
  collections: CollectionConfig[],
  blocks: Block[],
): BlockNestingMap {
  const knownSlugs = new Set(blocks.map((b) => b.slug))
  const edges: BlockNestingMap = []

  for (const collection of collections) {
    edges.push(
      ...collectBlocksFieldEdges(collection.fields, {
        owner: collection.slug,
        ownerType: 'collection',
        prefix: '',
        knownSlugs,
      }),
    )
  }

  for (const block of blocks) {
    edges.push(
      ...collectBlocksFieldEdges(block.fields, {
        owner: block.slug,
        ownerType: 'block',
        prefix: '',
        knownSlugs,
      }),
    )
  }

  return edges
}

/**
 * Build a relationship graph from introspected collection schemas.
 */
export function buildRelationshipGraph(
  schemas: Map<string, CollectionSchema>,
): RelationshipEdge[] {
  const edges: RelationshipEdge[] = []
  for (const [slug, schema] of schemas) {
    for (const rel of schema.relationships) {
      edges.push({
        fromCollection: slug,
        fieldName: rel.fieldName,
        toCollection: rel.relationTo,
        hasMany: rel.hasMany,
      })
    }
  }
  return edges
}

// ─── Internal helpers ──────────────────────────────────────────────

/**
 * Recursively extract field metadata from a Payload fields array.
 * Handles tabs, groups, arrays, rows, and collapsible containers.
 */
function extractFields(fields: Field[]): FieldSchema[] {
  const result: FieldSchema[] = []

  for (const field of fields) {
    if ('name' in field && field.name) {
      const schema: FieldSchema = {
        name: field.name,
        type: field.type,
      }

      if ('required' in field && field.required) schema.required = true
      if ('hasMany' in field && field.hasMany) schema.hasMany = true
      if ('relationTo' in field && field.relationTo) {
        schema.relationTo = field.relationTo as string | string[]
      }
      if ('maxRows' in field && field.maxRows) schema.maxRows = field.maxRows

      if (field.type === 'select' && 'options' in field && Array.isArray(field.options)) {
        schema.options = field.options.map((opt) =>
          typeof opt === 'string'
            ? { label: opt, value: opt }
            : { label: String(opt.label), value: String(opt.value) },
        )
      }

      if (field.type === 'array' && 'fields' in field) {
        schema.fields = extractFields(field.fields)
      }
      if (field.type === 'group' && 'fields' in field) {
        schema.fields = extractFields(field.fields)
      }

      result.push(schema)
    }

    if (field.type === 'tabs' && 'tabs' in field) {
      for (const tab of field.tabs) {
        if ('fields' in tab) {
          result.push(...extractFields(tab.fields))
        }
      }
    }
    if (field.type === 'row' && 'fields' in field) {
      result.push(...extractFields(field.fields))
    }
    if (field.type === 'collapsible' && 'fields' in field) {
      result.push(...extractFields(field.fields))
    }
  }

  return result
}

/**
 * Extract relationship metadata from fields (for the relationship graph).
 */
function extractRelationships(
  fields: Field[],
  prefix = '',
): Array<{ fieldName: string; relationTo: string | string[]; hasMany: boolean }> {
  const rels: Array<{ fieldName: string; relationTo: string | string[]; hasMany: boolean }> = []

  for (const field of fields) {
    const fieldName = 'name' in field && field.name ? `${prefix}${field.name}` : prefix

    if (field.type === 'relationship' && 'relationTo' in field) {
      rels.push({
        fieldName,
        relationTo: field.relationTo as string | string[],
        hasMany: !!('hasMany' in field && field.hasMany),
      })
    }

    if (field.type === 'upload' && 'relationTo' in field) {
      rels.push({
        fieldName,
        relationTo: field.relationTo as string,
        hasMany: !!('hasMany' in field && field.hasMany),
      })
    }

    if (field.type === 'tabs' && 'tabs' in field) {
      for (const tab of field.tabs) {
        if ('fields' in tab) {
          rels.push(...extractRelationships(tab.fields, prefix))
        }
      }
    }
    if (field.type === 'group' && 'fields' in field) {
      rels.push(...extractRelationships(field.fields, `${fieldName}.`))
    }
    if (field.type === 'array' && 'fields' in field) {
      rels.push(...extractRelationships(field.fields, `${fieldName}[].`))
    }
    if (field.type === 'row' && 'fields' in field) {
      rels.push(...extractRelationships(field.fields, prefix))
    }
    if (field.type === 'collapsible' && 'fields' in field) {
      rels.push(...extractRelationships(field.fields, prefix))
    }
  }

  return rels
}

interface NestingScanContext {
  owner: string
  ownerType: 'collection' | 'block'
  prefix: string
  knownSlugs: Set<string>
}

/**
 * Walk fields recording every `blocks`-typed field encountered, including
 * those nested in tabs/rows/groups/arrays/collapsibles. Each entry carries
 * the dotted path from the owner root to the field.
 */
function collectBlocksFieldEdges(fields: Field[], ctx: NestingScanContext): BlockNestingMap {
  const edges: BlockNestingMap = []

  for (const field of fields) {
    if (field.type === 'blocks') {
      const fieldName = 'name' in field && field.name ? field.name : ''
      const fullPath = ctx.prefix ? `${ctx.prefix}.${fieldName}` : fieldName
      const allSlugs = readBlockSlugs(field as Field & { type: 'blocks' })
      const acceptedSlugs = allSlugs.filter((s) => ctx.knownSlugs.has(s))

      const edge: BlockNestingMap[number] = {
        owner: ctx.owner,
        ownerType: ctx.ownerType,
        fieldPath: fullPath,
        acceptedBlockSlugs: acceptedSlugs,
      }
      const maxRows = (field as Field & { type: 'blocks' }).maxRows
      if (typeof maxRows === 'number') edge.maxRows = maxRows
      edges.push(edge)
      continue
    }

    if (field.type === 'tabs' && 'tabs' in field) {
      for (const tab of field.tabs) {
        if (!('fields' in tab)) continue
        const tabName = 'name' in tab && tab.name ? tab.name : ''
        const tabPrefix = tabName
          ? ctx.prefix
            ? `${ctx.prefix}.${tabName}`
            : tabName
          : ctx.prefix
        edges.push(...collectBlocksFieldEdges(tab.fields, { ...ctx, prefix: tabPrefix }))
      }
      continue
    }
    if (field.type === 'row' && 'fields' in field) {
      edges.push(...collectBlocksFieldEdges(field.fields, ctx))
      continue
    }
    if (field.type === 'collapsible' && 'fields' in field) {
      edges.push(...collectBlocksFieldEdges(field.fields, ctx))
      continue
    }
    if (field.type === 'group' && 'fields' in field && 'name' in field && field.name) {
      const newPrefix = ctx.prefix ? `${ctx.prefix}.${field.name}` : field.name
      edges.push(...collectBlocksFieldEdges(field.fields, { ...ctx, prefix: newPrefix }))
      continue
    }
    if (field.type === 'array' && 'fields' in field && 'name' in field && field.name) {
      const newPrefix = ctx.prefix ? `${ctx.prefix}.${field.name}[]` : `${field.name}[]`
      edges.push(...collectBlocksFieldEdges(field.fields, { ...ctx, prefix: newPrefix }))
      continue
    }
  }

  return edges
}

/**
 * Read block slugs from a blocks-typed field, handling both resolved
 * (field.blocks contains objects) and unresolved (field.blockReferences
 * holds slug strings) forms.
 */
function readBlockSlugs(field: Field & { type: 'blocks' }): string[] {
  const f = field as any

  if (
    Array.isArray(f.blocks) &&
    f.blocks.length > 0 &&
    typeof f.blocks[0] === 'object' &&
    f.blocks[0]?.slug
  ) {
    return f.blocks.map((b: { slug: string }) => b.slug)
  }

  if (Array.isArray(f.blockReferences) && f.blockReferences.length > 0) {
    return f.blockReferences.filter((ref: unknown) => typeof ref === 'string') as string[]
  }

  return []
}
