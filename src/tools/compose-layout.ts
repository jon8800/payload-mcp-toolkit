import { z } from 'zod'
import type { BlockCatalog } from '../types'
import {
  applyOperation,
  buildHint,
  composeSections,
  sectionSchema,
  type SectionInput,
} from './compose-helpers'

/**
 * Create the composePageLayout MCP tool from the introspected block catalog.
 *
 * Validates and composes a layout array from natural section/leaf inputs.
 * Returns the composed JSON ready to be written to a doc's `layout` field —
 * use updateDocument or patchLayout to actually persist the result.
 */
export function createComposeLayoutTool(catalog: BlockCatalog) {
  const sectionSlugs = catalog.sections.map((s) => s.slug)
  const leafSlugs = catalog.leaves.map((l) => l.slug)

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

      const { blocks, errors } = composeSections(sections, catalog)

      if (errors.length > 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                errors,
                hint: buildHint(catalog),
              }),
            },
          ],
        }
      }

      const finalLayout = applyOperation(blocks, operation, insertIndex, existingLayout)

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
