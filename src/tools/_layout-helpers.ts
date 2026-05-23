import { jsonResponse } from './_helpers'

/**
 * Shared internals for patchLayout (collections) and patchGlobalLayout
 * (globals). Both tools differ only in their fetch/write pairs and their
 * nesting-map filter — every other piece of logic (block validation,
 * operation application, dotted-path navigation, error shape) is identical
 * and lives here. Keeping them separate as tools is intentional from the
 * LLM's perspective; keeping the code single-sourced prevents the kind of
 * drift that originally let only one side learn about dotted paths.
 */

export function errorResponse(message: string, extra?: Record<string, unknown>) {
  return jsonResponse({ success: false, error: message, ...(extra ?? {}) })
}

/**
 * Recursively validate a block array against an allow list, descending into
 * each block's own `blocks`-typed fields when present. A value is treated
 * as a nested blocks field whenever it is an array of objects that each
 * carry a `blockType` discriminator; the nesting map decides which slugs
 * are admissible at that position.
 */
export function validateBlockList(
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

/**
 * Apply a list operation against an existing array of blocks.
 * `full` always replaces; the rest preserve the existing array.
 */
export function applyOperation(
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

/** Walk a dotted path on an object and return the value at the leaf, or `[]`
 * if any segment is missing or not an object. Used to pull the current
 * blocks array out of a fetched document/global. */
export function readPath(
  obj: Record<string, unknown> | undefined,
  path: string,
): Record<string, unknown>[] {
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

/**
 * Write `value` at a dotted `path`, returning a new object whose top-level
 * segment is a merge of `base`'s existing siblings with the patched leaf.
 *
 * Load-bearing for the sibling-wipe fix in patchGlobalLayout: Payload's
 * `updateGlobal` only merges at the top level. So if the global is
 * `{sections: {layout: [...], copyright: 'foo'}}` and we patch
 * `sections.layout`, naively writing `{sections: {layout: [...]}}` makes
 * Payload overwrite the entire `sections` group and `copyright` silently
 * vanishes. By accepting `base` (the existing document) we can splice the
 * new layout into a copy of every parent group along the dotted path,
 * preserving siblings at every depth. For a flat (non-dotted) path this
 * still produces `{[path]: value}` exactly as before — Payload then merges
 * other top-level fields normally — so existing callers see no change.
 */
export function writePath(
  base: Record<string, unknown> | undefined,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const parts = path.split('.')

  // Flat path: behave like the original `{[path]: value}` — Payload's
  // top-level merge handles all sibling preservation.
  if (parts.length === 1) {
    return { [parts[0]]: value }
  }

  // Dotted path: clone the top-level segment from `base` (so siblings of
  // every intermediate group survive) and walk down, copying each level on
  // the way so we never mutate the caller's `base`.
  const rootKey = parts[0]
  const baseRoot = base?.[rootKey]
  const rootClone: Record<string, unknown> =
    baseRoot && typeof baseRoot === 'object' && !Array.isArray(baseRoot)
      ? { ...(baseRoot as Record<string, unknown>) }
      : {}

  let cur = rootClone
  for (let i = 1; i < parts.length - 1; i++) {
    const key = parts[i]
    const next = cur[key]
    const cloned: Record<string, unknown> =
      next && typeof next === 'object' && !Array.isArray(next)
        ? { ...(next as Record<string, unknown>) }
        : {}
    cur[key] = cloned
    cur = cloned
  }
  cur[parts[parts.length - 1]] = value

  return { [rootKey]: rootClone }
}
