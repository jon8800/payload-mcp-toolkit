import type {
  BlockCatalog,
  CollectionSchema,
  RelationshipEdge,
} from './types'

/**
 * Generate MCP resources that expose the block catalog,
 * collection schemas, and relationship graph as static JSON.
 */
export function generateResources(
  schemas: Map<string, CollectionSchema>,
  catalog: BlockCatalog,
  relationships: RelationshipEdge[],
) {
  return [
    buildBlockCatalogResource(catalog),
    buildCollectionSchemaResource(schemas),
    buildRelationshipGraphResource(relationships),
  ]
}

// ─── Resource builders ────────────────────────────────────────────

function buildBlockCatalogResource(catalog: BlockCatalog) {
  const json = JSON.stringify(catalog, null, 2)

  return {
    name: 'blockCatalog',
    title: 'Block Catalog',
    description:
      'JSON catalog of all block types — section/leaf hierarchy, nesting rules, and required fields.',
    uri: 'blocks://catalog',
    mimeType: 'application/json',
    handler(uri: URL) {
      return {
        contents: [{ uri: uri.href, text: json }],
      }
    },
  }
}

function buildCollectionSchemaResource(schemas: Map<string, CollectionSchema>) {
  const obj: Record<string, CollectionSchema> = {}
  for (const [slug, schema] of schemas) {
    obj[slug] = schema
  }
  const json = JSON.stringify(obj, null, 2)

  return {
    name: 'collectionSchema',
    title: 'Collection Schema',
    description:
      'JSON schema of all collections — fields, select options, and relationship targets.',
    uri: 'collections://schema',
    mimeType: 'application/json',
    handler(uri: URL) {
      return {
        contents: [{ uri: uri.href, text: json }],
      }
    },
  }
}

function buildRelationshipGraphResource(relationships: RelationshipEdge[]) {
  const json = JSON.stringify(relationships, null, 2)

  return {
    name: 'relationshipGraph',
    title: 'Relationship Graph',
    description:
      'JSON representation of the collection relationship graph — which collections link to which.',
    uri: 'collections://relationships',
    mimeType: 'application/json',
    handler(uri: URL) {
      return {
        contents: [{ uri: uri.href, text: json }],
      }
    },
  }
}
