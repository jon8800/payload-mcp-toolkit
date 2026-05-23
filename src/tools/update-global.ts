import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import type { GlobalSchema } from '../types'
import { DRAFT_NOTE, errorMessage, slugEnum, stampMcpContext, textResponse } from './_helpers'

interface UpdateGlobalArgs {
  slug: string
  data: string
  locale?: string
}

/**
 * Partial-merge update for any global. Same prose-input contract as
 * `updateDocument`: `data` is a JSON string of field-name → value pairs,
 * unspecified fields are left untouched, and the response message lists
 * the changed top-level field names.
 *
 * For draft-enabled globals, the update lands as a new draft (mirrors the
 * `always-draft` default for draft-enabled collections); use
 * `publishGlobalDraft` to make it live.
 */
export function createUpdateGlobalTool(
  globalSchemas: Map<string, GlobalSchema>,
  draftGlobals: Set<string>,
) {
  const updatableSlugs = [...globalSchemas.keys()]
  const descriptionLines: string[] = []
  for (const [slug, schema] of globalSchemas) {
    descriptionLines.push(`  - "${slug}": ${schema.fields.map((f) => f.name).join(', ')}`)
  }
  const globalDescriptions = descriptionLines.join('\n')

  return {
    name: 'updateGlobal',
    routing: { kind: 'global', action: 'update' } as const,
    description:
      'Update fields on a global (site-wide settings singleton). ' +
      'Pass only the fields you want to change — unspecified fields are left untouched. ' +
      'For draft-enabled globals, updates create a new draft (use publishGlobalDraft to make it live).\n\n' +
      'Available globals and their fields:\n' +
      globalDescriptions,
    parameters: {
      slug: slugEnum(updatableSlugs, 'global').describe(
        `The global slug. One of: ${updatableSlugs.join(', ')}`,
      ),
      data: z
        .string()
        .describe(
          'JSON string of field names to new values. Only include fields you want to change. ' +
            'Examples: \'{"siteName":"Acme"}\', \'{"social":{"twitter":"@acme"}}\'.',
        ),
      locale: z
        .string()
        .optional()
        .describe(
          'Optional locale code (e.g. "en", "fr") to scope the update to a single locale on localized fields.',
        ),
    },
    handler: async (rawArgs: Record<string, unknown>, req: PayloadRequest, _extra: unknown) => {
      const args = rawArgs as unknown as UpdateGlobalArgs
      const { slug, locale } = args

      let data: Record<string, unknown>
      try {
        data = JSON.parse(args.data)
      } catch {
        return textResponse(
          'Error: "data" must be a valid JSON string. Example: \'{"siteName":"Acme"}\'',
        )
      }

      if (!globalSchemas.has(slug)) {
        return textResponse(
          `Error: Unknown global "${slug}". Available: ${updatableSlugs.join(', ')}`,
        )
      }

      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
        return textResponse(
          'Error: No fields provided in "data". Pass an object with field names and values to update.',
        )
      }

      stampMcpContext(req)
      const isDraftGlobal = draftGlobals.has(slug)

      try {
        await req.payload.updateGlobal({
          slug: slug as never,
          data: data as never,
          draft: isDraftGlobal,
          ...(locale ? { locale: locale as never } : {}),
          req,
          overrideAccess: false,
          user: req.user,
        })

        const updatedFields = Object.keys(data).join(', ')
        const draftNote = isDraftGlobal ? DRAFT_NOTE : ''
        return textResponse(
          `Updated global "${slug}". Changed fields: ${updatedFields}.${draftNote}`,
        )
      } catch (err) {
        return textResponse(`Error updating global "${slug}": ${errorMessage(err)}`)
      }
    },
  }
}
