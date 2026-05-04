import type {
  BlockCatalog,
  BlockNestingMap,
  CollectionSchema,
  RelationshipEdge,
} from './types'

/**
 * Generate MCP resources that expose the introspected schema as static JSON.
 *
 * Four resources:
 * - blocks://catalog — flat list of every block and its fields
 * - blocks://nesting — per-blocks-field map of which slugs each field accepts
 * - collections://schema — collection field metadata
 * - collections://relationships — collection relationship graph
 */
export function generateResources(
  schemas: Map<string, CollectionSchema>,
  catalog: BlockCatalog,
  nesting: BlockNestingMap,
  relationships: RelationshipEdge[],
) {
  return [
    buildJsonResource({
      name: 'blockCatalog',
      title: 'Block Catalog',
      description:
        'Flat list of every block type and its fields. Pair with the blockNesting resource to know where each block can be placed.',
      uri: 'blocks://catalog',
      payload: catalog,
    }),
    buildJsonResource({
      name: 'blockNesting',
      title: 'Block Nesting Map',
      description:
        'For every blocks-typed field in the schema (in collections and inside other blocks), lists the block slugs that field accepts. Use this to compose nested layouts at any depth.',
      uri: 'blocks://nesting',
      payload: nesting,
    }),
    buildJsonResource({
      name: 'collectionSchema',
      title: 'Collection Schema',
      description:
        'JSON schema of all collections — fields, select options, and relationship targets.',
      uri: 'collections://schema',
      payload: Object.fromEntries(schemas),
    }),
    buildJsonResource({
      name: 'relationshipGraph',
      title: 'Relationship Graph',
      description:
        'JSON representation of the collection relationship graph — which collections link to which.',
      uri: 'collections://relationships',
      payload: relationships,
    }),
  ]
}

function buildJsonResource(args: {
  name: string
  title: string
  description: string
  uri: string
  payload: unknown
}) {
  const json = JSON.stringify(args.payload, null, 2)
  return {
    name: args.name,
    title: args.title,
    description: args.description,
    uri: args.uri,
    mimeType: 'application/json',
    handler(uri: URL) {
      return {
        contents: [{ uri: uri.href, text: json }],
      }
    },
  }
}

