import type { Block } from 'payload'
import { Heading } from '../leaves/Heading'

export const HeadingOnly: Block = {
  slug: 'headingOnly',
  fields: [
    {
      name: 'content',
      type: 'blocks',
      maxRows: 1,
      blocks: [Heading],
    },
  ],
}
