import { z } from 'zod'
import type { PayloadRequest } from 'payload'
import { validateAndFetchUrl } from '../url-validator'

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

/**
 * Creates the uploadMedia MCP tool that fetches an image from a public URL,
 * validates it for SSRF safety and content type, then creates a Media document.
 */
export function createUploadMediaTool(options?: {
  maxFileSize?: number
  collectionSlug?: string
}) {
  const maxFileSize = options?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE
  const mediaSlug = options?.collectionSlug ?? 'media'

  return {
    name: 'uploadMedia',
    description:
      'Upload an image to the media library from a public HTTPS URL. ' +
      'Fetches the image with SSRF protection, validates it is an allowed image type ' +
      '(JPEG, PNG, WebP, GIF), and creates a Media document with alt text. ' +
      'Returns the created document ID, filename, and alt text.',
    parameters: {
      url: z.string().url().describe('Public HTTPS URL of the image to upload'),
      alt: z
        .string()
        .optional()
        .describe('Alt text for the image. Generates from filename if omitted.'),
    },
    handler: async (
      args: { url: string; alt?: string },
      req: PayloadRequest,
      _extra: unknown,
    ) => {
      const { url } = args

      let buffer: Buffer
      let contentType: string
      let filename: string
      try {
        const result = await validateAndFetchUrl(url, { maxBytes: maxFileSize })
        buffer = result.buffer
        contentType = result.contentType
        filename = result.filename
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching URL: ${message}`,
            },
          ],
        }
      }

      if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: Unsupported Content-Type "${contentType}". ` +
                `Allowed types: ${[...ALLOWED_IMAGE_TYPES].join(', ')}`,
            },
          ],
        }
      }

      if (buffer.byteLength > maxFileSize) {
        const sizeMB = (buffer.byteLength / (1024 * 1024)).toFixed(2)
        const limitMB = (maxFileSize / (1024 * 1024)).toFixed(2)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: File size ${sizeMB}MB exceeds maximum ${limitMB}MB.`,
            },
          ],
        }
      }

      const alt =
        args.alt ||
        filename
          .replace(/\.[^.]+$/, '')
          .replace(/[-_]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim() ||
        'Uploaded image'

      req.context = { ...req.context, source: 'mcp' }

      try {
        const doc = await req.payload.create({
          collection: mediaSlug as any,
          data: { alt } as any,
          file: {
            data: buffer,
            mimetype: contentType,
            name: filename,
            size: buffer.byteLength,
          },
          req,
          overrideAccess: false,
          user: req.user,
        })

        return {
          content: [
            {
              type: 'text' as const,
              text: `Successfully uploaded "${filename}" to ${mediaSlug}.\n` +
                `ID: ${doc.id}\n` +
                `Filename: ${filename}\n` +
                `Alt: ${alt}`,
            },
          ],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error creating media document: ${message}`,
            },
          ],
        }
      }
    },
  }
}
