import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import type { BlockCatalog } from '../types'
import {
  applyOperation,
  buildHint,
  composeSections,
  sectionSchema,
  type SectionInput,
} from './compose-helpers'

/**
 * Creates the patchLayout MCP tool — a surgical wrapper around composePageLayout
 * that mutates a single document's layout-style field directly, never round-tripping
 * the entire array through updateDocument.
 *
 * Why this exists: prompting an LLM to "add a CTA at the bottom of the home page"
 * via updateDocument forces it to send the entire layout array, which one bad token
 * can wipe out. patchLayout fetches the current layout itself, applies a scoped
 * operation, and writes back — the LLM only ever describes the delta.
 *
 * Defaults to layoutField "layout" but accepts any block-array field name.
 */
export function createPatchLayoutTool(
  catalog: BlockCatalog,
  draftCollections: Set<string>,
) {
  const sectionSlugs = catalog.sections.map((s) => s.slug)
  const leafSlugs = catalog.leaves.map((l) => l.slug)

  return {
    name: 'patchLayout',
    description:
      'Surgically modify a document\'s block-array field (e.g. "layout") without ' +
      'sending the whole array. Pass only the sections to add or replace plus an operation ' +
      '(append, prepend, insertAt, replaceAt). The current layout is fetched server-side ' +
      'and the operation is applied atomically. Safer than updateDocument for incremental edits. ' +
      `Available sections: ${sectionSlugs.join(', ')}. Available leaves: ${leafSlugs.join(', ')}.`,
    parameters: {
      collection: z.string().describe('The collection slug containing the document'),
      documentId: z.string().describe('The ID of the document to patch'),
      layoutField: z
        .string()
        .optional()
        .default('layout')
        .describe('Name of the block-array field to patch (default "layout")'),
      sections: z
        .array(sectionSchema)
        .describe('Sections to compose. Same shape as composePageLayout.'),
      operation: z
        .enum(['append', 'prepend', 'insertAt', 'replaceAt', 'full'])
        .describe(
          'How to apply the sections: append (end), prepend (start), insertAt (at index), ' +
          'replaceAt (overwrite N starting at index), full (replace entire array — use with care).',
        ),
      insertIndex: z
        .number()
        .optional()
        .describe('Index for insertAt/replaceAt operations'),
    },
    handler: async (
      args: {
        collection: string
        documentId: string
        layoutField?: string
        sections: SectionInput[]
        operation: 'append' | 'prepend' | 'insertAt' | 'replaceAt' | 'full'
        insertIndex?: number
      },
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const {
        collection,
        documentId,
        layoutField = 'layout',
        sections,
        operation,
        insertIndex,
      } = args

      // Compose the new sections first — fail fast on validation errors before touching the doc
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

      req.context = { ...req.context, source: 'mcp' }

      // Fetch current document so we can read the existing layout array
      let existing: any
      try {
        existing = await req.payload.findByID({
          collection: collection as any,
          id: documentId,
          draft: true,
          req,
          overrideAccess: false,
          user: req.user,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching ${collection}#${documentId}: ${message}`,
            },
          ],
        }
      }

      const currentLayout = Array.isArray(existing?.[layoutField]) ? existing[layoutField] : []
      const finalLayout = applyOperation(blocks, operation, insertIndex, currentLayout)

      const isDraftCollection = draftCollections.has(collection)

      try {
        const updated = await req.payload.update({
          collection: collection as any,
          id: documentId,
          data: { [layoutField]: finalLayout } as any,
          draft: isDraftCollection,
          req,
          overrideAccess: false,
          user: req.user,
        })

        const displayName =
          (updated as any).name ||
          (updated as any).title ||
          (updated as any).slug ||
          documentId

        const draftNote = isDraftCollection
          ? ' Document is in draft status — use publishDraft to make it live.'
          : ''

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message:
                  `Patched ${layoutField} on "${displayName}" (${collection}#${documentId}). ` +
                  `Operation: ${operation}. Block count: ${finalLayout.length}.` +
                  draftNote,
                blockCount: finalLayout.length,
                operation,
              }),
            },
          ],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error patching ${collection}#${documentId}: ${message}`,
            },
          ],
        }
      }
    },
  }
}
