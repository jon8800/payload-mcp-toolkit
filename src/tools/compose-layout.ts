import { z } from 'zod'
import type { BlockCatalog, SectionBlockSchema } from '../types'

/** Schema for a single leaf block within a section */
const leafBlockSchema = z.object({
  blockType: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
})

/** Schema for a single section in the layout */
const sectionSchema = z.object({
  sectionType: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
  /** Leaf blocks for single-content sections */
  content: z.array(leafBlockSchema).optional(),
  /** Left column leaf blocks (for two-column sections) */
  leftColumn: z.array(leafBlockSchema).optional(),
  /** Right column leaf blocks (for two-column sections) */
  rightColumn: z.array(leafBlockSchema).optional(),
  /** Flat field values for fixed sections */
  fields: z.record(z.string(), z.unknown()).optional(),
})

type LeafBlockInput = z.infer<typeof leafBlockSchema>
type SectionInput = z.infer<typeof sectionSchema>

interface ValidationError {
  sectionIndex: number
  message: string
  validAlternatives?: string[]
}

/**
 * Create the composePageLayout MCP tool from the introspected block catalog.
 */
export function createComposeLayoutTool(catalog: BlockCatalog) {
  const sectionSlugs = catalog.sections.map((s) => s.slug)
  const leafSlugs = catalog.leaves.map((l) => l.slug)
  const sectionMap = new Map(catalog.sections.map((s) => [s.slug, s]))

  return {
    name: 'composePageLayout',
    description:
      'Compose a page layout from section and leaf blocks. Validates nesting rules and required fields. ' +
      'Returns block JSON ready for the Payload page layout field. ' +
      `Available sections: ${sectionSlugs.join(', ')}. Available leaves: ${leafSlugs.join(', ')}.`,
    parameters: z.object({
      sections: z
        .array(sectionSchema)
        .describe('Array of section blocks to compose into a layout'),
      operation: z
        .enum(['full', 'append', 'prepend', 'insertAt', 'replaceAt'])
        .optional()
        .default('full')
        .describe('How to apply sections: full replace, append, prepend, insertAt, or replaceAt'),
      insertIndex: z
        .number()
        .optional()
        .describe('Index for insertAt/replaceAt operations'),
      existingLayout: z
        .array(z.record(z.string(), z.unknown()))
        .optional()
        .describe('Current page layout JSON for partial update operations'),
    }),
    handler: async (args: {
      sections: SectionInput[]
      operation?: 'full' | 'append' | 'prepend' | 'insertAt' | 'replaceAt'
      insertIndex?: number
      existingLayout?: Record<string, unknown>[]
    }) => {
      const { sections, operation = 'full', insertIndex, existingLayout } = args

      const errors: ValidationError[] = []
      const composedBlocks: Record<string, unknown>[] = []

      for (let i = 0; i < sections.length; i++) {
        const section = sections[i]
        const result = validateAndComposeSection(section, i, sectionMap, leafSlugs)

        if (result.errors.length > 0) {
          errors.push(...result.errors)
        } else if (result.block) {
          composedBlocks.push(result.block)
        }
      }

      if (errors.length > 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                errors,
                hint: {
                  availableSections: sectionSlugs,
                  availableLeaves: leafSlugs,
                  sectionDetails: catalog.sections.map((s) => ({
                    slug: s.slug,
                    nestingType: s.nestingType,
                    acceptedLeaves: s.acceptedLeafSlugs,
                    maxRows: s.maxRows,
                  })),
                },
              }),
            },
          ],
        }
      }

      const finalLayout = applyOperation(composedBlocks, operation, insertIndex, existingLayout)

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              layout: finalLayout,
              blockCount: finalLayout.length,
            }),
          },
        ],
      }
    },
  }
}

// ─── Internal helpers ──────────────────────────────────────────────

interface ComposeResult {
  block: Record<string, unknown> | null
  errors: ValidationError[]
}

function validateAndComposeSection(
  section: SectionInput,
  index: number,
  sectionMap: Map<string, SectionBlockSchema>,
  allLeafSlugs: string[],
): ComposeResult {
  const sectionSchema = sectionMap.get(section.sectionType)

  if (!sectionSchema) {
    return {
      block: null,
      errors: [
        {
          sectionIndex: index,
          message: `Unknown section type: "${section.sectionType}"`,
          validAlternatives: [...sectionMap.keys()],
        },
      ],
    }
  }

  if (sectionSchema.nestingType === 'fixed') {
    return composeFixedSection(section, index, sectionSchema)
  }

  // Detect two-column layout by leftColumn block field
  const hasDualColumns = sectionSchema.fields.some(
    (f) => f.name === 'leftColumn' && f.type === 'blocks',
  )

  if (hasDualColumns) {
    return composeTwoColumnSection(section, index, sectionSchema, allLeafSlugs)
  }

  return composeContentSection(section, index, sectionSchema, allLeafSlugs)
}

function composeFixedSection(
  section: SectionInput,
  index: number,
  schema: SectionBlockSchema,
): ComposeResult {
  const errors = validateRequiredFields(section.fields ?? {}, schema.fields, index)
  if (errors.length > 0) {
    return { block: null, errors }
  }

  const block: Record<string, unknown> = {
    blockType: schema.slug,
    ...(section.fields ?? {}),
    ...(section.config ?? {}),
  }

  return { block, errors: [] }
}

function composeContentSection(
  section: SectionInput,
  index: number,
  schema: SectionBlockSchema,
  allLeafSlugs: string[],
): ComposeResult {
  const content = section.content ?? []
  const errors: ValidationError[] = []

  const leafErrors = validateLeafBlocks(content, schema, index, 'content', allLeafSlugs)
  errors.push(...leafErrors)

  if (schema.maxRows && content.length > schema.maxRows) {
    errors.push({
      sectionIndex: index,
      message: `Section "${schema.slug}" allows at most ${schema.maxRows} content block(s), got ${content.length}`,
    })
  }

  if (errors.length > 0) {
    return { block: null, errors }
  }

  const blockFieldName = findBlockFieldName(schema, 'content')

  const composedLeaves = content.map((leaf) => ({
    blockType: leaf.blockType,
    ...(leaf.fields ?? {}),
  }))

  const block: Record<string, unknown> = {
    blockType: schema.slug,
    [blockFieldName]: composedLeaves,
    ...(section.config ?? {}),
    ...(section.fields ?? {}),
  }

  return { block, errors: [] }
}

function composeTwoColumnSection(
  section: SectionInput,
  index: number,
  schema: SectionBlockSchema,
  allLeafSlugs: string[],
): ComposeResult {
  const leftColumn = section.leftColumn ?? []
  const rightColumn = section.rightColumn ?? []
  const errors: ValidationError[] = []

  const leftErrors = validateLeafBlocks(leftColumn, schema, index, 'leftColumn', allLeafSlugs)
  errors.push(...leftErrors)

  const rightErrors = validateLeafBlocks(rightColumn, schema, index, 'rightColumn', allLeafSlugs)
  errors.push(...rightErrors)

  if (errors.length > 0) {
    return { block: null, errors }
  }

  const block: Record<string, unknown> = {
    blockType: schema.slug,
    leftColumn: leftColumn.map((leaf) => ({
      blockType: leaf.blockType,
      ...(leaf.fields ?? {}),
    })),
    rightColumn: rightColumn.map((leaf) => ({
      blockType: leaf.blockType,
      ...(leaf.fields ?? {}),
    })),
    ...(section.config ?? {}),
  }

  return { block, errors: [] }
}

function validateLeafBlocks(
  leaves: LeafBlockInput[],
  sectionSchema: SectionBlockSchema,
  sectionIndex: number,
  columnName: string,
  allLeafSlugs: string[],
): ValidationError[] {
  const errors: ValidationError[] = []

  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i]

    if (!allLeafSlugs.includes(leaf.blockType)) {
      errors.push({
        sectionIndex,
        message: `Unknown leaf block type "${leaf.blockType}" at ${columnName}[${i}]`,
        validAlternatives: allLeafSlugs,
      })
      continue
    }

    if (!sectionSchema.acceptedLeafSlugs.includes(leaf.blockType)) {
      errors.push({
        sectionIndex,
        message: `Leaf block "${leaf.blockType}" is not allowed in section "${sectionSchema.slug}" at ${columnName}[${i}]`,
        validAlternatives: sectionSchema.acceptedLeafSlugs,
      })
    }
  }

  return errors
}

function validateRequiredFields(
  values: Record<string, unknown>,
  fieldSchemas: Array<{ name: string; type: string; required?: boolean }>,
  sectionIndex: number,
): ValidationError[] {
  const errors: ValidationError[] = []

  for (const field of fieldSchemas) {
    if (!field.required) continue
    if (['id', 'blockName', 'blockType'].includes(field.name)) continue

    const value = values[field.name]
    if (value === undefined || value === null || value === '') {
      errors.push({
        sectionIndex,
        message: `Required field "${field.name}" is missing`,
      })
    }
  }

  return errors
}

function findBlockFieldName(
  schema: SectionBlockSchema,
  defaultName: string,
): string {
  const hasDefault = schema.fields.some((f) => f.name === defaultName && f.type === 'blocks')
  if (hasDefault) return defaultName

  const blocksField = schema.fields.find((f) => f.type === 'blocks')
  if (blocksField) return blocksField.name

  return defaultName
}

function applyOperation(
  composedBlocks: Record<string, unknown>[],
  operation: string,
  insertIndex: number | undefined,
  existingLayout: Record<string, unknown>[] | undefined,
): Record<string, unknown>[] {
  if (operation === 'full' || !existingLayout) {
    return composedBlocks
  }

  const existing = [...existingLayout]

  if (operation === 'append') {
    return [...existing, ...composedBlocks]
  }

  if (operation === 'prepend') {
    return [...composedBlocks, ...existing]
  }

  if (operation === 'insertAt') {
    if (insertIndex === undefined || insertIndex < 0 || insertIndex > existing.length) {
      return [...existing, ...composedBlocks]
    }
    existing.splice(insertIndex, 0, ...composedBlocks)
    return existing
  }

  if (operation === 'replaceAt') {
    if (insertIndex === undefined || insertIndex < 0 || insertIndex >= existing.length) {
      return existing
    }
    existing.splice(insertIndex, composedBlocks.length, ...composedBlocks)
    return existing
  }

  return composedBlocks
}
