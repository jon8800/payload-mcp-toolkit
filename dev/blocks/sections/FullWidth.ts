import type { Block } from 'payload'
import { Heading } from '../leaves/Heading'
import { RichText } from '../leaves/RichText'
import { ImageBlock } from '../leaves/ImageBlock'
import { ButtonGroup } from '../leaves/ButtonGroup'
import { Quote } from '../leaves/Quote'

export const FullWidth: Block = {
  slug: 'fullWidth',
  fields: [
    {
      name: 'content',
      type: 'blocks',
      blocks: [Heading, RichText, ImageBlock, ButtonGroup, Quote],
    },
    {
      name: 'background',
      type: 'select',
      defaultValue: 'none',
      options: [
        { label: 'None', value: 'none' },
        { label: 'Subtle', value: 'subtle' },
        { label: 'Inverted', value: 'inverted' },
      ],
    },
  ],
}
