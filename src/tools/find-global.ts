import { z } from 'zod'
import type { GlobalConfig, PayloadRequest } from 'payload'
import type { GlobalSchema } from '../types'
import { errorMessage, jsonResponse, stampMcpContext, textResponse } from './_helpers'

interface FindGlobalArgs {
  slug: string
  draft?: boolean
  depth?: number
}

/**
 * Read any global by slug. Mirrors `findDocument`'s slug-enum + draft +
 * preview behaviour but acts on Payload's `findGlobal` Local API method —
 * globals are singletons, so there's no `id`, `where`, or `limit`.
 *
 * Preview stamping uses each global's `admin.livePreview.url` (preferred)
 * or `admin.preview` function, same fallback chain as collections.
 */
export function createFindGlobalTool(
  globalSchemas: Map<string, GlobalSchema>,
  draftGlobals: Set<string>,
  globalsBySlug: Map<string, GlobalConfig>,
  previewSiteUrl: string | undefined,
  previewDisabled = false,
) {
  const findableSlugs = [...globalSchemas.keys()]
  const descriptionLines = findableSlugs.map(
    (slug) => `  - "${slug}"${draftGlobals.has(slug) ? ' (draft-enabled)' : ''}`,
  )

  return {
    name: 'findGlobal',
    description:
      'Read a global (a singleton site-wide settings document) by slug. ' +
      'Globals carry things like site name, footer config, navigation menus — there is no `id`, no list, no `where` filter. ' +
      'Use `draft: true` to read the draft version of a draft-enabled global.\n\n' +
      'Available globals:\n' +
      descriptionLines.join('\n'),
    parameters: {
      slug: z
        .enum(findableSlugs as [string, ...string[]])
        .describe(`The global slug. One of: ${findableSlugs.join(', ')}`),
      draft: z
        .boolean()
        .optional()
        .describe(
          'When true, returns the draft version of a draft-enabled global. Default false (published).',
        ),
      depth: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe('Relationship population depth. Default 1.'),
    },
    handler: async (args: FindGlobalArgs, req: PayloadRequest, _extra: unknown) => {
      const { slug, draft, depth } = args

      if (!globalSchemas.has(slug)) {
        return textResponse(
          `Error: Unknown global "${slug}". Available: ${findableSlugs.join(', ')}`,
        )
      }

      stampMcpContext(req)
      const globalConfig = globalsBySlug.get(slug)

      try {
        const doc = await req.payload.findGlobal({
          slug: slug as never,
          depth: depth ?? 1,
          draft: draft ?? false,
          req,
          overrideAccess: false,
          user: req.user,
        })

        const base = jsonResponse(doc)
        if (previewDisabled || !globalConfig) return base

        const isDraft =
          (doc as Record<string, unknown> | undefined)?._status === 'draft'
        if (!isDraft) return base

        const previewUrl = await resolveGlobalPreviewUrl(
          globalConfig,
          doc as Record<string, unknown>,
          req,
          previewSiteUrl,
        )
        const hint = previewUrl
          ? `\n📋 This global is in draft status. Preview it here: ${previewUrl}`
          : '\n📋 This global is in draft status. Use the admin panel to preview it.'
        return { content: [...base.content, { type: 'text', text: hint }] }
      } catch (err) {
        return textResponse(`Error reading global "${slug}": ${errorMessage(err)}`)
      }
    },
  }
}

/**
 * Resolve a preview URL from a global's `admin.livePreview.url` / `admin.preview`
 * config. Same fallback chain as `resolvePreviewUrl` for collections, but
 * passes `globalConfig` (not `collectionConfig`) to the user callback.
 */
async function resolveGlobalPreviewUrl(
  global: GlobalConfig,
  doc: Record<string, unknown>,
  req: PayloadRequest,
  siteUrl: string | undefined,
): Promise<string | null> {
  const admin = (global.admin ?? {}) as Record<string, any>
  const locale = (req as unknown as { locale?: string }).locale ?? 'en'

  let raw: string | null | undefined

  const livePreviewUrl = admin.livePreview?.url
  if (typeof livePreviewUrl === 'function') {
    try {
      raw = await livePreviewUrl({
        data: doc,
        locale: { code: locale, label: locale },
        req,
        payload: req.payload,
        globalConfig: global,
      })
    } catch {
      raw = null
    }
  } else if (typeof livePreviewUrl === 'string') {
    raw = livePreviewUrl
  }

  if (!raw && typeof admin.preview === 'function') {
    try {
      raw = await admin.preview(doc, { locale, req, token: null })
    } catch {
      raw = null
    }
  }

  if (!raw || typeof raw !== 'string') return null
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw
  if (!siteUrl) return null

  const base = siteUrl.endsWith('/') ? siteUrl.slice(0, -1) : siteUrl
  const path = raw.startsWith('/') ? raw : `/${raw}`
  return `${base}${path}`
}
