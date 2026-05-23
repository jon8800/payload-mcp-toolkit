import { z } from 'zod'
import type { CollectionConfig, PayloadRequest } from 'payload'

/**
 * Build a `z.enum` over a list of valid resource slugs with a friendly
 * error message that names the valid set and clarifies why an unknown
 * slug (e.g. one removed via `options.exclude.globals`) is rejected.
 *
 * Default Zod enum errors are "Invalid enum value. …" — accurate but
 * unhelpful when the slug looks plausible to a caller who isn't aware
 * the host config excluded it.
 */
export function slugEnum(
  slugs: string[],
  kind: 'global' | 'collection',
): z.ZodEnum<[string, ...string[]]> {
  return z.enum(slugs as [string, ...string[]], {
    errorMap: () => ({
      message: `${kind === 'global' ? 'Global' : 'Collection'} slug must be one of: ${slugs.join(', ')}. Unknown or excluded slugs are rejected.`,
    }),
  })
}

export interface McpTextResponse {
  content: Array<{ type: 'text'; text: string }>
}

export const DRAFT_NOTE = ' Document is in draft status — use publishDraft to make it live.'

export function textResponse(text: string): McpTextResponse {
  return { content: [{ type: 'text', text }] }
}

export function jsonResponse(payload: unknown): McpTextResponse {
  return textResponse(JSON.stringify(payload))
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function stampMcpContext(req: PayloadRequest): void {
  req.context = { ...req.context, source: 'mcp' }
}

export function getDocDisplayName(doc: unknown, fallback: string): string {
  const d = doc as Record<string, unknown> | null | undefined
  return (
    (typeof d?.name === 'string' && d.name) ||
    (typeof d?.title === 'string' && d.title) ||
    (typeof d?.slug === 'string' && d.slug) ||
    fallback
  )
}

export function requireDraftCollection(
  collection: string,
  draftCollections: Set<string>,
  noun = 'drafts',
): McpTextResponse | null {
  if (draftCollections.has(collection)) return null
  return textResponse(
    `Error: Collection "${collection}" does not support ${noun}. ` +
      `Draft-enabled collections: ${[...draftCollections].join(', ') || 'none'}`,
  )
}

/**
 * Resolves the preview URL for a draft document by delegating to the
 * collection's own configured preview function (`admin.livePreview.url`
 * preferred, then `admin.preview`). Returns null when no function is
 * configured, when it fails, or when it returns a relative path with no
 * absolute `siteUrl` to anchor it.
 */
export async function resolvePreviewUrl(
  collection: CollectionConfig,
  doc: Record<string, unknown>,
  req: PayloadRequest,
  siteUrl: string | undefined,
): Promise<string | null> {
  const admin = (collection.admin ?? {}) as Record<string, any>
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
        collectionConfig: collection,
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

/**
 * If `doc` is a draft, appends a preview-URL hint to the MCP response so the
 * AI can present it to the user. Falls back to a generic admin-panel hint
 * when the collection has no preview function configured.
 *
 * Pure with respect to the response: a fresh content array is returned.
 */
export async function decorateDraftResponse(
  response: McpTextResponse,
  doc: Record<string, unknown> | null | undefined,
  collection: CollectionConfig | undefined,
  req: PayloadRequest,
  siteUrl: string | undefined,
): Promise<McpTextResponse> {
  if (!doc || doc._status !== 'draft' || !collection) return response

  const previewUrl = await resolvePreviewUrl(collection, doc, req, siteUrl)
  const hint = previewUrl
    ? `\n📋 This document is a draft. Preview it here: ${previewUrl}`
    : '\n📋 This document is a draft. Use the admin panel to preview it.'

  return { content: [...response.content, { type: 'text', text: hint }] }
}
