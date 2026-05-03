import type { CollectionConfig } from 'payload'
import { allSectionBlocks } from '../blocks'

export const Pages: CollectionConfig = {
  slug: 'pages',
  admin: {
    useAsTitle: 'title',
    defaultColumns: ['title', 'slug', '_status'],
    livePreview: {
      url: ({ data }) => {
        const slug = (data?.slug as string) ?? ''
        return slug ? `/${slug}` : '/'
      },
    },
  },
  versions: {
    drafts: {
      autosave: { interval: 800 },
    },
  },
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Page',
          fields: [
            { name: 'title', type: 'text', required: true },
            { name: 'slug', type: 'text', required: true, unique: true, index: true },
            {
              name: 'layout',
              type: 'blocks',
              blocks: allSectionBlocks,
            },
          ],
        },
        {
          name: 'hero',
          label: 'Hero',
          fields: [
            { name: 'heroTitle', type: 'text' },
            { name: 'heroSubtitle', type: 'text' },
            {
              name: 'heroSize',
              type: 'select',
              options: [
                { label: 'Small', value: 'small' },
                { label: 'Medium', value: 'medium' },
                { label: 'Large', value: 'large' },
              ],
              defaultValue: 'medium',
            },
            { name: 'heroImage', type: 'upload', relationTo: 'media' },
          ],
        },
        {
          label: 'SEO',
          fields: [
            {
              name: 'seo',
              type: 'group',
              fields: [
                { name: 'metaTitle', type: 'text' },
                { name: 'metaDescription', type: 'textarea' },
                { name: 'ogImage', type: 'upload', relationTo: 'media' },
              ],
            },
          ],
        },
      ],
    },
  ],
}
