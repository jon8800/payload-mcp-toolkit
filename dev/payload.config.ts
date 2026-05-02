import path from 'path'
import { fileURLToPath } from 'url'
import { buildConfig } from 'payload'
import { sqliteAdapter } from '@payloadcms/db-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { contentToolkitPlugin } from 'payload-mcp-toolkit'

import { Users } from './collections/Users'
import { Media } from './collections/Media'
import { Categories } from './collections/Categories'
import { Authors } from './collections/Authors'
import { Posts } from './collections/Posts'
import { Pages } from './collections/Pages'
import { SiteSettings } from './globals/SiteSettings'
import { allSectionBlocks, allLeafBlocks } from './blocks'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default buildConfig({
  admin: {
    user: Users.slug,
  },
  collections: [Users, Media, Categories, Authors, Posts, Pages],
  globals: [SiteSettings],
  blocks: [...allSectionBlocks, ...allLeafBlocks],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || 'dev-secret-not-for-production',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: sqliteAdapter({
    client: {
      url: process.env.DATABASE_URI || 'file:./dev.db',
    },
  }),
  plugins: [
    contentToolkitPlugin({
      siteUrl: process.env.SITE_URL || 'http://localhost:3000',
      previewSecret: process.env.PREVIEW_SECRET || 'preview-secret',
      previewPaths: {
        pages: '',
        posts: '/blog',
      },
      draftBehavior: {
        pages: 'always-draft',
        posts: 'always-draft',
      },
      domainPrompts: [
        {
          name: 'sampleSiteVocabulary',
          title: 'Sample Site Vocabulary',
          description: 'Demonstrates how to teach the AI site-specific terms.',
          content: [
            'This is a sample CMS used to exercise the payload-mcp-toolkit plugin.',
            '',
            'Content model:',
            '- "Pages" = top-level marketing/info pages built from section blocks (drafts enabled).',
            '- "Posts" = blog articles with category, authors, cover image, and tags (drafts enabled).',
            '- "Authors" = people who write posts.',
            '- "Categories" = taxonomy for posts.',
            '',
            'Common workflows:',
            '- Compose a page with composePageLayout → updateDocument(layout) → publishDraft.',
            '- Create a post with create → uploadMedia for cover → updateDocument → publishDraft.',
          ].join('\n'),
        },
      ],
    }),
  ],
})
