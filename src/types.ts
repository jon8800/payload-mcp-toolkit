import type { CollectionConfig, Block, Config, GlobalConfig } from 'payload'

/** Draft behavior per collection */
export type DraftBehavior = 'always-draft' | 'always-publish'

/** Configuration for the content toolkit plugin */
export interface ContentToolkitOptions {
  /** Base URL of the site (used for preview URLs). e.g. "https://example.com" */
  siteUrl: string

  /** Secret used for preview URL authentication */
  previewSecret: string

  /**
   * Per-collection URL path prefix used when constructing preview URLs.
   * Keys are collection slugs; values are the path segment placed before the doc slug.
   * Use an empty string for collections that live at the site root (e.g. pages).
   *
   * Example:
   *   {
   *     posts: '/blog',
   *     products: '/shop',
   *     pages: '',
   *   }
   *
   * Collections without an entry default to `/{slug}`.
   */
  previewPaths?: Record<string, string>

  /**
   * Explicit list of block slugs that should be treated as **section** blocks
   * (top-level layout containers). Any block not in this list is treated as
   * a **leaf** block (composable inside a section's `blocks` field).
   *
   * When omitted, the toolkit falls back to a heuristic: blocks that contain
   * a nested `blocks`-type field are sections, all others are leaves. This
   * heuristic mis-classifies "fixed" sections (sections with no nested blocks
   * but their own standalone fields, e.g. a CTA banner). Pass this option
   * to disambiguate.
   *
   * Example: `['hero', 'fullWidth', 'twoColumn', 'ctaBanner']`
   */
  sectionBlockSlugs?: string[]

  /** Site-specific domain prompts that teach the AI business vocabulary */
  domainPrompts?: DomainPrompt[]

  /** Per-collection draft behavior overrides (keyed by collection slug) */
  draftBehavior?: Record<string, DraftBehavior>

  /** Media upload configuration */
  mediaUpload?: {
    /** Maximum file size in bytes (default: 10MB) */
    maxFileSize?: number
    /** Media collection slug (default: 'media') */
    collectionSlug?: string
  }

  /** Collections to exclude from MCP exposure */
  excludeCollections?: string[]

  /** Globals to exclude from MCP exposure */
  excludeGlobals?: string[]
}

/** A domain prompt that teaches the AI site-specific vocabulary */
export interface DomainPrompt {
  /** Unique name for the prompt */
  name: string
  /** Display title */
  title: string
  /** Description of what this prompt teaches */
  description: string
  /** The prompt content */
  content: string
}

/** Introspected field metadata */
export interface FieldSchema {
  name: string
  type: string
  required?: boolean
  hasMany?: boolean
  relationTo?: string | string[]
  options?: Array<{ label: string; value: string }>
  fields?: FieldSchema[]
  maxRows?: number
}

/** Introspected collection metadata */
export interface CollectionSchema {
  slug: string
  fields: FieldSchema[]
  hasDrafts: boolean
  hasLivePreview: boolean
  relationships: Array<{ fieldName: string; relationTo: string | string[]; hasMany: boolean }>
  searchableFields: string[]
}

/** Block nesting classification */
export type BlockNestingType = 'composable' | 'constrained' | 'fixed'

/** Introspected section block metadata */
export interface SectionBlockSchema {
  slug: string
  nestingType: BlockNestingType
  acceptedLeafSlugs: string[]
  maxRows?: number
  fields: FieldSchema[]
}

/** Introspected leaf block metadata */
export interface LeafBlockSchema {
  slug: string
  fields: FieldSchema[]
}

/** Complete block catalog */
export interface BlockCatalog {
  sections: SectionBlockSchema[]
  leaves: LeafBlockSchema[]
}

/** Relationship edge in the collection graph */
export interface RelationshipEdge {
  fromCollection: string
  fieldName: string
  toCollection: string | string[]
  hasMany: boolean
}
