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

function asIsoString(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString()
  return undefined
}

export type PublishVerifyTarget =
  | { kind: 'collection'; slug: string; id: string }
  | { kind: 'global'; slug: string; locale?: string }

/**
 * Capture the document's current `updatedAt` BEFORE a publish attempt so
 * the recovery branch can tell "this attempt landed despite a post-write
 * validator throw" from "an older publish was successful and this attempt
 * did nothing". A missing snapshot is non-fatal — the recovery branch
 * conservatively falls through to the original error in that case.
 */
export async function snapshotPublishMarker(
  req: PayloadRequest,
  target: PublishVerifyTarget,
): Promise<string | undefined> {
  try {
    const pre =
      target.kind === 'collection'
        ? await req.payload.findByID({
            collection: target.slug as any,
            id: target.id,
            draft: true,
            depth: 0,
            req,
            overrideAccess: false,
            user: req.user,
          })
        : await req.payload.findGlobal({
            slug: target.slug as never,
            draft: true,
            depth: 0,
            // `fallbackLocale: false` disables Payload's locale-fallback so
            // the read returns the literal state of the requested locale.
            // Without this, a localized global with fallbackLocale='en'
            // could report the 'en' updatedAt while the caller is
            // publishing 'de', producing a false-positive in
            // verifyPublishSucceededDespiteError.
            ...(target.locale
              ? { locale: target.locale as never, fallbackLocale: false as never }
              : {}),
            req,
            overrideAccess: false,
            user: req.user,
          })
    return asIsoString((pre as { updatedAt?: unknown } | null | undefined)?.updatedAt)
  } catch {
    return undefined
  }
}

/**
 * After a Payload update throws on a publish call, determine whether the
 * publish actually landed despite the error. Returns the live document
 * only when (a) the live `_status` is 'published' AND (b) `updatedAt`
 * strictly advanced past the pre-update snapshot — i.e. the current
 * attempt produced the published row. Without the strictly-newer check,
 * a pre-existing published version from an earlier successful publish
 * would mask a real failure of the current attempt.
 *
 * Returns null on:
 *   - missing pre-snapshot (cannot disambiguate; conservative)
 *   - verify read failure (do not mask the original error with a
 *     secondary read error)
 *   - live `_status` not 'published'
 *   - live `updatedAt` not strictly newer than the pre-snapshot
 */
export async function verifyPublishSucceededDespiteError(
  req: PayloadRequest,
  target: PublishVerifyTarget,
  preUpdatedAt: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!preUpdatedAt) return null
  try {
    const live =
      target.kind === 'collection'
        ? await req.payload.findByID({
            collection: target.slug as any,
            id: target.id,
            draft: false,
            depth: 0,
            req,
            overrideAccess: false,
            user: req.user,
          })
        : await req.payload.findGlobal({
            slug: target.slug as never,
            draft: false,
            depth: 0,
            // Disable Payload locale-fallback (see snapshotPublishMarker
            // note) so verify reads the literal state of the locale that
            // updateGlobal was called against.
            ...(target.locale
              ? { locale: target.locale as never, fallbackLocale: false as never }
              : {}),
            req,
            overrideAccess: false,
            user: req.user,
          })
    const d = live as Record<string, unknown> | null | undefined
    if (!d || d._status !== 'published') return null
    const liveUpdatedAt = asIsoString(d.updatedAt)
    if (!liveUpdatedAt || liveUpdatedAt <= preUpdatedAt) return null
    return d
  } catch (verifyError) {
    req.payload.logger?.debug?.(
      { event: 'mcp.publish.verify_read_failed', err: verifyError },
      '[payload-mcp-toolkit] publish-recovery verify-read failed; surfacing original error',
    )
    return null
  }
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
