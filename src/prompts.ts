import type {
  BlockCatalog,
  CollectionSchema,
  DomainPrompt,
  RelationshipEdge,
} from './types'

/**
 * Generate MCP prompts that teach the AI about the content model.
 *
 * Auto-generates three prompts (content model overview, block composition guide,
 * draft workflow guide) and merges with any user-provided domain prompts.
 */
export function generatePrompts(
  schemas: Map<string, CollectionSchema>,
  catalog: BlockCatalog,
  relationships: RelationshipEdge[],
  domainPrompts?: DomainPrompt[],
) {
  const prompts = [
    buildContentModelOverview(schemas, relationships),
    buildBlockCompositionGuide(catalog),
    buildDraftWorkflowGuide(schemas),
  ]

  if (domainPrompts?.length) {
    for (const dp of domainPrompts) {
      prompts.push({
        name: dp.name,
        title: dp.title,
        description: dp.description,
        handler() {
          return {
            messages: [
              {
                content: { type: 'text' as const, text: dp.content },
                role: 'user' as const,
              },
            ],
          }
        },
      })
    }
  }

  return prompts
}

// ─── Prompt builders ──────────────────────────────────────────────

function buildContentModelOverview(
  schemas: Map<string, CollectionSchema>,
  relationships: RelationshipEdge[],
) {
  return {
    name: 'contentModelOverview',
    title: 'Content Model Overview',
    description:
      'Describes every collection in the CMS — its purpose, fields, and relationships to other collections.',
    handler() {
      const lines: string[] = ['# Content Model Overview', '']

      for (const [slug, schema] of schemas) {
        lines.push(`## Collection: ${slug}`)
        lines.push(`Draft support: ${schema.hasDrafts ? 'yes' : 'no'}`)
        lines.push(`Live preview: ${schema.hasLivePreview ? 'yes' : 'no'}`)
        lines.push('')

        // Fields summary
        lines.push('### Fields')
        for (const field of schema.fields) {
          const parts = [`- **${field.name}** (${field.type})`]
          if (field.required) parts.push(' *required*')
          if (field.hasMany) parts.push(' hasMany')
          if (field.relationTo) {
            const targets = Array.isArray(field.relationTo)
              ? field.relationTo.join(', ')
              : field.relationTo
            parts.push(` → ${targets}`)
          }
          if (field.options?.length) {
            const vals = field.options.map((o) => o.value).join(', ')
            parts.push(` [${vals}]`)
          }
          if (field.maxRows) parts.push(` maxRows: ${field.maxRows}`)
          lines.push(parts.join(''))
        }
        lines.push('')

        // Relationships
        const collRels = relationships.filter((r) => r.fromCollection === slug)
        if (collRels.length > 0) {
          lines.push('### Relationships')
          for (const rel of collRels) {
            const targets = Array.isArray(rel.toCollection)
              ? rel.toCollection.join(', ')
              : rel.toCollection
            lines.push(
              `- ${rel.fieldName} → ${targets}${rel.hasMany ? ' (hasMany)' : ''}`,
            )
          }
          lines.push('')
        }
      }

      return {
        messages: [
          {
            content: { type: 'text' as const, text: lines.join('\n') },
            role: 'user' as const,
          },
        ],
      }
    },
  }
}

function buildBlockCompositionGuide(catalog: BlockCatalog) {
  return {
    name: 'blockCompositionGuide',
    title: 'Block Composition Guide',
    description:
      'Explains the section/leaf block hierarchy, valid nesting rules, and how to compose page layouts.',
    handler() {
      const lines: string[] = [
        '# Block Composition Guide',
        '',
        'Pages are built from **section** blocks. Each section can contain **leaf** blocks according to its nesting rules.',
        '',
      ]

      // Section blocks
      lines.push('## Section Blocks')
      for (const section of catalog.sections) {
        lines.push(`### ${section.slug} (${section.nestingType})`)

        if (section.nestingType === 'fixed') {
          lines.push('This section has no nested blocks — configure it with its own fields only.')
        } else if (section.nestingType === 'constrained') {
          lines.push(
            `Accepts only: ${section.acceptedLeafSlugs.join(', ')}`,
          )
          if (section.maxRows) {
            lines.push(`Maximum ${section.maxRows} leaf block(s).`)
          }
        } else {
          lines.push(
            `Accepts all leaf blocks: ${section.acceptedLeafSlugs.join(', ')}`,
          )
        }

        if (section.fields.length > 0) {
          lines.push('Section-level fields:')
          for (const f of section.fields) {
            lines.push(`  - ${f.name} (${f.type})${f.required ? ' *required*' : ''}`)
          }
        }
        lines.push('')
      }

      // Leaf blocks
      lines.push('## Leaf Blocks')
      for (const leaf of catalog.leaves) {
        lines.push(`### ${leaf.slug}`)
        if (leaf.fields.length > 0) {
          for (const f of leaf.fields) {
            lines.push(`  - ${f.name} (${f.type})${f.required ? ' *required*' : ''}`)
          }
        }
        lines.push('')
      }

      return {
        messages: [
          {
            content: { type: 'text' as const, text: lines.join('\n') },
            role: 'user' as const,
          },
        ],
      }
    },
  }
}

function buildDraftWorkflowGuide(schemas: Map<string, CollectionSchema>) {
  return {
    name: 'draftWorkflowGuide',
    title: 'Draft Workflow Guide',
    description:
      'Explains which collections support drafts, how to create drafts, review them, and publish.',
    handler() {
      const draftCollections: string[] = []
      const publishCollections: string[] = []

      for (const [slug, schema] of schemas) {
        if (schema.hasDrafts) {
          draftCollections.push(slug)
        } else {
          publishCollections.push(slug)
        }
      }

      const lines: string[] = [
        '# Draft Workflow Guide',
        '',
        '## Collections with draft support',
        '',
      ]

      if (draftCollections.length === 0) {
        lines.push('No collections have draft support enabled.')
      } else {
        for (const slug of draftCollections) {
          lines.push(`- **${slug}**`)
        }
        lines.push('')
        lines.push('### How drafts work')
        lines.push(
          '1. When you create or update a document in a draft-enabled collection, set `_status: "draft"` to keep it unpublished.',
        )
        lines.push(
          '2. Draft documents are only visible via preview URLs or the admin panel — they are not public.',
        )
        lines.push(
          '3. To publish a draft, update the document with `_status: "published"` or use the `publishDraft` tool.',
        )
        lines.push(
          '4. You can review a draft via its preview URL before publishing.',
        )
      }

      lines.push('')
      lines.push('## Collections without draft support')
      lines.push('')

      if (publishCollections.length === 0) {
        lines.push('All collections support drafts.')
      } else {
        for (const slug of publishCollections) {
          lines.push(`- **${slug}** — changes are published immediately`)
        }
      }

      return {
        messages: [
          {
            content: { type: 'text' as const, text: lines.join('\n') },
            role: 'user' as const,
          },
        ],
      }
    },
  }
}
