import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import type { BlockCatalog, BlockNestingMap } from '../types'
import { DRAFT_NOTE, errorMessage, jsonResponse, stampMcpContext } from './_helpers'

/**
 * patchGlobalLayout — surgical wrapper that mutates a single blocks-typed
 * field on a global without round-tripping the entire array through
 * updateGlobal. Same operation grammar as patchLayout (append, prepend,
 * insertAt, replaceAt, full); same recursive nesting validator against the
 * unified BlockNestingMap.
 *
 * Returns null when no global has any blocks field — the plugin entry
 * skips registration in that case, mirroring the schedulePublish pattern.
 */
export function createPatchGlobalLayoutTool(
  catalog: BlockCatalog,
  nesting: BlockNestingMap,
  draftGlobals: Set<string>,
) {
  const allBlockSlugs = new Set(catalog.blocks.map((b) => b.slug))

  const nestingByGlobalField = new Map<string, string[]>()
  const nestingByBlockField = new Map<string, string[]>()
  for (const edge of nesting) {
    const key = `${edge.owner}:${edge.fieldPath}`
    if (edge.ownerType === 'global') {
      nestingByGlobalField.set(key, edge.acceptedBlockSlugs)
    } else if (edge.ownerType === 'block') {
      nestingByBlockField.set(key, edge.acceptedBlockSlugs)
    }
  }

  // Conditional registration: no global has a blocks field → no tool.
  if (nestingByGlobalField.size === 0) return null

  return {
    name: 'patchGlobalLayout',
    description:
      'Surgically modify a blocks-typed field on a global (e.g. footer sections, header nav) without sending the whole array. Same operation grammar as patchLayout. Use the blockNesting resource to see which slugs each field accepts; global-owned edges have ownerType "global".',
    parameters: {
      slug: z.string().describe('The global slug whose blocks-typed field will be patched'),
      layoutField: z
        .string()
        .describe(
          'Name (or dotted path) of the blocks-typed field on the global to patch — e.g. "layout", "footer.sections".',
        ),
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
      insertIndex: z.number().optional().describe('Index for insertAt/replaceAt operations'),
    },
    handler: async (
      args: {
        slug: string
        layoutField: string
        blocks: Array<Record<string, unknown>>
        operation: 'append' | 'prepend' | 'insertAt' | 'replaceAt' | 'full'
        insertIndex?: number
      },
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { slug, layoutField, blocks, operation, insertIndex } = args

      const rootKey = `${slug}:${layoutField}`
      const rootAllowed = nestingByGlobalField.get(rootKey)
      if (!rootAllowed) {
        return errorResponse(
          `Field "${layoutField}" on global "${slug}" is not a blocks-typed field, or no nesting map entry exists for it.`,
          { availableFields: [...nestingByGlobalField.keys()] },
        )
      }

      const errors: string[] = []
      validateBlockList(blocks, rootAllowed, layoutField, allBlockSlugs, nestingByBlockField, errors)

      if (errors.length > 0) {
        return errorResponse('Block validation failed.', { errors })
      }

      stampMcpContext(req)

      let existing: Record<string, unknown> | undefined
      try {
        existing = (await req.payload.findGlobal({
          slug: slug as never,
          depth: 0,
          draft: true,
          req,
          overrideAccess: false,
          user: req.user,
        })) as Record<string, unknown> | undefined
      } catch (error) {
        return errorResponse(`Error fetching global "${slug}": ${errorMessage(error)}`)
      }

      const currentLayout = readPath(existing, layoutField)
      const finalLayout = applyOperation(blocks, operation, insertIndex, currentLayout)

      const isDraftGlobal = draftGlobals.has(slug)

      try {
        await req.payload.updateGlobal({
          slug: slug as never,
          data: writePath({}, layoutField, finalLayout) as never,
          draft: isDraftGlobal,
          req,
          overrideAccess: false,
          user: req.user,
        })

        const draftNote = isDraftGlobal ? DRAFT_NOTE : ''
        return jsonResponse({
          success: true,
          message:
            `Patched ${layoutField} on global "${slug}". ` +
            `Operation: ${operation}. Block count: ${finalLayout.length}.` +
            draftNote,
          blockCount: finalLayout.length,
          operation,
        })
      } catch (error) {
        return errorResponse(`Error patching global "${slug}": ${errorMessage(error)}`)
      }
    },
  }
}

function errorResponse(message: string, extra?: Record<string, unknown>) {
  return jsonResponse({ success: false, error: message, ...(extra ?? {}) })
}

/** Walk a dotted path on an object and return the value (or undefined). */
function readPath(obj: Record<string, unknown> | undefined, path: string): Record<string, unknown>[] {
  if (!obj) return []
  const parts = path.split('.')
  let cur: unknown = obj
  for (const part of parts) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      cur = (cur as Record<string, unknown>)[part]
    } else {
      return []
    }
  }
  return Array.isArray(cur) ? (cur as Record<string, unknown>[]) : []
}

/** Set a dotted path on an object to a value (creating intermediate groups). */
function writePath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = path.split('.')
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    const next = cur[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = {}
    }
    cur = cur[key] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
  return obj
}

function validateBlockList(
  blocks: Array<Record<string, unknown>>,
  allowedSlugs: string[],
  pathLabel: string,
  allBlockSlugs: Set<string>,
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

    if (!allBlockSlugs.has(slug)) {
      errors.push(`${here}: unknown blockType "${slug}". Known: ${[...allBlockSlugs].join(', ')}`)
      continue
    }

    if (!allowedSlugs.includes(slug)) {
      errors.push(
        `${here}: blockType "${slug}" not allowed here. Allowed at this position: ${allowedSlugs.join(', ') || '(none)'}`,
      )
      continue
    }

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
