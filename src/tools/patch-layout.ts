import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import type { BlockCatalog, BlockNestingMap } from '../types'

/**
 * Creates the patchLayout MCP tool — a surgical wrapper that mutates a single
 * document's blocks-typed field directly without round-tripping the entire
 * array through `updateDocument`.
 *
 * Why this exists: prompting an LLM to "add a CTA at the bottom of the home
 * page" via updateDocument forces it to send the whole layout array, which one
 * bad token can wipe out. patchLayout fetches the current array itself,
 * applies a scoped operation, and writes back — the LLM only describes the
 * delta.
 *
 * Validation walks every block recursively against the introspected
 * BlockNestingMap, so arbitrarily-nested layouts work as long as each
 * `blocks`-typed field's content matches that field's allow list.
 */
export function createPatchLayoutTool(
  catalog: BlockCatalog,
  nesting: BlockNestingMap,
  draftCollections: Set<string>,
) {
  const allBlockSlugs = catalog.blocks.map((b) => b.slug)

  // Pre-build lookups keyed by `<owner>:<fieldPath>` for O(1) access during
  // recursive validation.
  const nestingByCollectionField = new Map<string, string[]>()
  const nestingByBlockField = new Map<string, string[]>()
  for (const edge of nesting) {
    const key = `${edge.owner}:${edge.fieldPath}`
    if (edge.ownerType === 'collection') {
      nestingByCollectionField.set(key, edge.acceptedBlockSlugs)
    } else {
      nestingByBlockField.set(key, edge.acceptedBlockSlugs)
    }
  }

  return {
    name: 'patchLayout',
    description:
      'Surgically modify a document\'s blocks-typed field (e.g. "layout") without sending the whole array. Pass the blocks to add/replace plus an operation (append, prepend, insertAt, replaceAt, full). The current array is fetched server-side and the operation is applied atomically. Each block must include a `blockType` plus its fields; nested `blocks`-typed fields can contain arbitrarily-deep block arrays as long as each level matches the schema. Use the `blockNesting` resource to see which slugs each field accepts.',
    parameters: {
      collection: z.string().describe('The collection slug containing the document'),
      documentId: z.string().describe('The ID of the document to patch'),
      layoutField: z
        .string()
        .optional()
        .default('layout')
        .describe('Name of the blocks-typed field to patch (default "layout")'),
      blocks: z
        .array(z.record(z.string(), z.unknown()))
        .describe(
          'Blocks to compose. Each must have a `blockType` discriminator plus any block-specific fields. Nested blocks fields hold their own `blocks` arrays at any depth.',
        ),
      operation: z
        .enum(['append', 'prepend', 'insertAt', 'replaceAt', 'full'])
        .describe(
          'How to apply the blocks: append (end), prepend (start), insertAt (at index), replaceAt (overwrite N starting at index), full (replace entire array — use with care).',
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
        blocks: Array<Record<string, unknown>>
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
        blocks,
        operation,
        insertIndex,
      } = args

      // Validate the incoming blocks against the nesting map for the target
      // field before touching the database.
      const rootKey = `${collection}:${layoutField}`
      const rootAllowed = nestingByCollectionField.get(rootKey)
      if (!rootAllowed) {
        return errorResponse(
          `Field "${layoutField}" on collection "${collection}" is not a blocks-typed field, or no nesting map entry exists for it.`,
          { availableFields: [...nestingByCollectionField.keys()] },
        )
      }

      const errors: string[] = []
      validateBlockList(blocks, rootAllowed, layoutField, allBlockSlugs, nestingByBlockField, errors)

      if (errors.length > 0) {
        return errorResponse('Block validation failed.', { errors })
      }

      req.context = { ...req.context, source: 'mcp' }

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
        return errorResponse(`Error fetching ${collection}#${documentId}: ${message}`)
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
        return errorResponse(`Error patching ${collection}#${documentId}: ${message}`)
      }
    },
  }
}

function errorResponse(message: string, extra?: Record<string, unknown>) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: false, error: message, ...(extra ?? {}) }),
      },
    ],
  }
}

/**
 * Recursively validate a block array against an allow list, descending into
 * each block's own `blocks`-typed fields when present.
 */
function validateBlockList(
  blocks: Array<Record<string, unknown>>,
  allowedSlugs: string[],
  pathLabel: string,
  allBlockSlugs: string[],
  nestingByBlockField: Map<string, string[]>,
  errors: string[],
) {
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const here = `${pathLabel}[${i}]`

    if (!block || typeof block !== 'object') {
      errors.push(`${here}: not an object`)
      continue
    }

    const slug = block.blockType
    if (typeof slug !== 'string' || !slug) {
      errors.push(`${here}: missing string \`blockType\``)
      continue
    }

    if (!allBlockSlugs.includes(slug)) {
      errors.push(`${here}: unknown blockType "${slug}". Known: ${allBlockSlugs.join(', ')}`)
      continue
    }

    if (!allowedSlugs.includes(slug)) {
      errors.push(
        `${here}: blockType "${slug}" not allowed here. Allowed at this position: ${allowedSlugs.join(', ') || '(none)'}`,
      )
      continue
    }

    // Recurse: any value on this block that is itself an array of objects with
    // `blockType` is treated as a nested blocks field. Cross-check the field
    // name against the nesting map so we know the allow list for the next level.
    for (const [fieldName, value] of Object.entries(block)) {
      if (!Array.isArray(value)) continue
      if (value.length === 0) continue
      if (!value.every((v) => v && typeof v === 'object' && 'blockType' in v)) continue

      const nextKey = `${slug}:${fieldName}`
      const nextAllowed = nestingByBlockField.get(nextKey)
      if (!nextAllowed) {
        errors.push(
          `${here}.${fieldName}: block "${slug}" has no blocks field named "${fieldName}" in the schema`,
        )
        continue
      }

      validateBlockList(
        value as Array<Record<string, unknown>>,
        nextAllowed,
        `${here}.${fieldName}`,
        allBlockSlugs,
        nestingByBlockField,
        errors,
      )
    }
  }
}

/**
 * Apply a list operation against an existing array of blocks.
 * `full` always replaces; the rest preserve the existing array.
 */
function applyOperation(
  newBlocks: Record<string, unknown>[],
  operation: 'full' | 'append' | 'prepend' | 'insertAt' | 'replaceAt',
  insertIndex: number | undefined,
  existingLayout: Record<string, unknown>[] | undefined,
): Record<string, unknown>[] {
  if (operation === 'full' || !existingLayout) {
    return newBlocks
  }

  const existing = [...existingLayout]

  if (operation === 'append') return [...existing, ...newBlocks]
  if (operation === 'prepend') return [...newBlocks, ...existing]

  if (operation === 'insertAt') {
    if (insertIndex === undefined || insertIndex < 0 || insertIndex > existing.length) {
      return [...existing, ...newBlocks]
    }
    existing.splice(insertIndex, 0, ...newBlocks)
    return existing
  }

  if (operation === 'replaceAt') {
    if (insertIndex === undefined || insertIndex < 0 || insertIndex >= existing.length) {
      return existing
    }
    existing.splice(insertIndex, newBlocks.length, ...newBlocks)
    return existing
  }

  return newBlocks
}
