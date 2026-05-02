import { z } from 'zod'
import type { BlockCatalog, SectionBlockSchema } from '../types'

/** Schema for a single leaf block within a section */
export const leafBlockSchema = z.object({
  blockType: z.string(),
  fields: z.record(z.string(), z.unknown()).optional(),
})

/** Schema for a single section in a layout */
export const sectionSchema = z.object({
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

export type LeafBlockInput = z.infer<typeof leafBlockSchema>
export type SectionInput = z.infer<typeof sectionSchema>

export interface ValidationError {
  sectionIndex: number
  message: string
  validAlternatives?: string[]
}

export interface ComposeResult {
  blocks: Record<string, unknown>[]
  errors: ValidationError[]
}

/**
 * Validate and compose an array of section inputs into block JSON.
 * Returns either composed blocks or a list of validation errors.
 */
export function composeSections(
  sections: SectionInput[],
  catalog: BlockCatalog,
): ComposeResult {
  const sectionMap = new Map(catalog.sections.map((s) => [s.slug, s]))
  const allLeafSlugs = catalog.leaves.map((l) => l.slug)

  const blocks: Record<string, unknown>[] = []
  const errors: ValidationError[] = []

  for (let i = 0; i < sections.length; i++) {
    const result = composeSingleSection(sections[i], i, sectionMap, allLeafSlugs)
    if (result.errors.length > 0) {
      errors.push(...result.errors)
    } else if (result.block) {
      blocks.push(result.block)
    }
  }

  return { blocks, errors }
}

/** Build a hint payload describing the available section/leaf vocabulary. */
export function buildHint(catalog: BlockCatalog) {
  return {
    availableSections: catalog.sections.map((s) => s.slug),
    availableLeaves: catalog.leaves.map((l) => l.slug),
    sectionDetails: catalog.sections.map((s) => ({
      slug: s.slug,
      nestingType: s.nestingType,
      acceptedLeaves: s.acceptedLeafSlugs,
      maxRows: s.maxRows,
    })),
  }
}

/**
 * Apply a list operation against an existing array of blocks.
 * `full` always replaces; the rest preserve the existing array.
 */
export function applyOperation(
  composedBlocks: Record<string, unknown>[],
  operation: 'full' | 'append' | 'prepend' | 'insertAt' | 'replaceAt',
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

// ─── Internal composition logic ──────────────────────────────────

interface SingleResult {
  block: Record<string, unknown> | null
  errors: ValidationError[]
}

function composeSingleSection(
  section: SectionInput,
  index: number,
  sectionMap: Map<string, SectionBlockSchema>,
  allLeafSlugs: string[],
): SingleResult {
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
): SingleResult {
  const errors = validateRequiredFields(section.fields ?? {}, schema.fields, index)
  if (errors.length > 0) return { block: null, errors }

  return {
    block: {
      blockType: schema.slug,
      ...(section.fields ?? {}),
      ...(section.config ?? {}),
    },
    errors: [],
  }
}

function composeContentSection(
  section: SectionInput,
  index: number,
  schema: SectionBlockSchema,
  allLeafSlugs: string[],
): SingleResult {
  const content = section.content ?? []
  const errors = validateLeafBlocks(content, schema, index, 'content', allLeafSlugs)

  if (schema.maxRows && content.length > schema.maxRows) {
    errors.push({
      sectionIndex: index,
      message: `Section "${schema.slug}" allows at most ${schema.maxRows} content block(s), got ${content.length}`,
    })
  }

  if (errors.length > 0) return { block: null, errors }

  const blockFieldName = findBlockFieldName(schema, 'content')
  const composedLeaves = content.map((leaf) => ({
    blockType: leaf.blockType,
    ...(leaf.fields ?? {}),
  }))

  return {
    block: {
      blockType: schema.slug,
      [blockFieldName]: composedLeaves,
      ...(section.config ?? {}),
      ...(section.fields ?? {}),
    },
    errors: [],
  }
}

function composeTwoColumnSection(
  section: SectionInput,
  index: number,
  schema: SectionBlockSchema,
  allLeafSlugs: string[],
): SingleResult {
  const leftColumn = section.leftColumn ?? []
  const rightColumn = section.rightColumn ?? []
  const errors: ValidationError[] = [
    ...validateLeafBlocks(leftColumn, schema, index, 'leftColumn', allLeafSlugs),
    ...validateLeafBlocks(rightColumn, schema, index, 'rightColumn', allLeafSlugs),
  ]

  if (errors.length > 0) return { block: null, errors }

  return {
    block: {
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
    },
    errors: [],
  }
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
