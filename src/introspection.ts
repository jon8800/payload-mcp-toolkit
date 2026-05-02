import type { Block, CollectionConfig, Field, GlobalConfig } from 'payload'
import type {
  BlockCatalog,
  BlockNestingType,
  CollectionSchema,
  FieldSchema,
  LeafBlockSchema,
  RelationshipEdge,
  SectionBlockSchema,
} from './types'

/**
 * Introspect a Payload collection config into structured metadata.
 */
export function introspectCollection(collection: CollectionConfig): CollectionSchema {
  const fields = extractFields(collection.fields)
  const relationships = extractRelationships(collection.fields)
  const searchableFields = fields
    .filter((f) => ['text', 'email'].includes(f.type) && ['name', 'title', 'slug'].includes(f.name))
    .map((f) => f.name)

  const hasDrafts = !!(collection.versions && typeof collection.versions === 'object' && 'drafts' in collection.versions && collection.versions.drafts)
  const hasLivePreview = !!(collection.admin && typeof collection.admin === 'object' && 'livePreview' in collection.admin && collection.admin.livePreview)

  return {
    slug: collection.slug,
    fields,
    hasDrafts,
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
 * Introspect block configs into a block catalog with section/leaf hierarchy and nesting rules.
 *
 * NOTE: In the Payload plugin context, blockReferences may or may not be resolved
 * depending on when introspection runs. This function handles both cases:
 * - If field.blocks contains resolved block objects, reads slugs from them
 * - If field.blocks is empty and field.blockReferences exists, uses those slugs directly
 */
export function introspectBlocks(
  sectionBlocks: Block[],
  leafBlocks: Block[],
): BlockCatalog {
  const leafSlugs = new Set(leafBlocks.map((b) => b.slug))

  const sections: SectionBlockSchema[] = sectionBlocks.map((section) => {
    const blockFields = findBlockFields(section.fields)

    if (blockFields.length === 0) {
      // Fixed section — no nested blocks
      return {
        slug: section.slug,
        nestingType: 'fixed' as BlockNestingType,
        acceptedLeafSlugs: [],
        fields: extractFields(section.fields),
      }
    }

    // Determine accepted leaf slugs from all blocks-type fields
    const acceptedSlugs = new Set<string>()
    let maxRows: number | undefined

    for (const bf of blockFields) {
      const slugs = getBlockSlugsFromField(bf)
      for (const s of slugs) {
        if (leafSlugs.has(s)) acceptedSlugs.add(s)
      }
      if (bf.maxRows) maxRows = bf.maxRows
    }

    const nestingType: BlockNestingType =
      acceptedSlugs.size < leafSlugs.size || maxRows ? 'constrained' : 'composable'

    return {
      slug: section.slug,
      nestingType,
      acceptedLeafSlugs: [...acceptedSlugs],
      maxRows,
      fields: extractFields(section.fields),
    }
  })

  const leaves: LeafBlockSchema[] = leafBlocks.map((leaf) => ({
    slug: leaf.slug,
    fields: extractFields(leaf.fields),
  }))

  return { sections, leaves }
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
      if ('relationTo' in field && field.relationTo) schema.relationTo = field.relationTo as string | string[]
      if ('maxRows' in field && field.maxRows) schema.maxRows = field.maxRows

      // Extract select options
      if (field.type === 'select' && 'options' in field && Array.isArray(field.options)) {
        schema.options = field.options.map((opt) =>
          typeof opt === 'string' ? { label: opt, value: opt } : { label: String(opt.label), value: String(opt.value) },
        )
      }

      // Recurse into nested fields (arrays, groups)
      if (field.type === 'array' && 'fields' in field) {
        schema.fields = extractFields(field.fields)
      }
      if (field.type === 'group' && 'fields' in field) {
        schema.fields = extractFields(field.fields)
      }

      result.push(schema)
    }

    // Transparent containers — recurse without creating a named field
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

    // Recurse into containers
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

/**
 * Find all blocks-type fields within a field array (recursing into tabs/rows/etc).
 */
function findBlockFields(fields: Field[]): Array<Field & { type: 'blocks' }> {
  const result: Array<Field & { type: 'blocks' }> = []

  for (const field of fields) {
    if (field.type === 'blocks') {
      result.push(field as Field & { type: 'blocks' })
    }
    if (field.type === 'tabs' && 'tabs' in field) {
      for (const tab of field.tabs) {
        if ('fields' in tab) {
          result.push(...findBlockFields(tab.fields))
        }
      }
    }
    if (field.type === 'row' && 'fields' in field) {
      result.push(...findBlockFields(field.fields))
    }
    if (field.type === 'collapsible' && 'fields' in field) {
      result.push(...findBlockFields(field.fields))
    }
    if (field.type === 'group' && 'fields' in field) {
      result.push(...findBlockFields(field.fields))
    }
  }

  return result
}

/**
 * Get block slugs from a blocks-type field.
 * Handles both resolved blocks (field.blocks has objects) and unresolved blockReferences.
 */
function getBlockSlugsFromField(field: Field & { type: 'blocks' }): string[] {
  const f = field as any

  // Resolved blocks — field.blocks contains full block objects
  if (Array.isArray(f.blocks) && f.blocks.length > 0 && typeof f.blocks[0] === 'object' && f.blocks[0].slug) {
    return f.blocks.map((b: { slug: string }) => b.slug)
  }

  // Unresolved — blockReferences contains slug strings
  if (Array.isArray(f.blockReferences) && f.blockReferences.length > 0) {
    return f.blockReferences.filter((ref: unknown) => typeof ref === 'string') as string[]
  }

  return []
}
