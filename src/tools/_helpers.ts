import type { PayloadRequest } from 'payload'

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
