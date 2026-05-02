import type { Block } from 'payload'
import { Heading } from '../leaves/Heading'
import { RichText } from '../leaves/RichText'
import { ImageBlock } from '../leaves/ImageBlock'
import { ButtonGroup } from '../leaves/ButtonGroup'
import { Quote } from '../leaves/Quote'

const allLeaves = [Heading, RichText, ImageBlock, ButtonGroup, Quote]

export const TwoColumn: Block = {
  slug: 'twoColumn',
  fields: [
    {
      name: 'leftColumn',
      type: 'blocks',
      blocks: allLeaves,
    },
    {
      name: 'rightColumn',
      type: 'blocks',
      blocks: allLeaves,
    },
    {
      name: 'verticalAlign',
      type: 'select',
      defaultValue: 'top',
      options: [
        { label: 'Top', value: 'top' },
        { label: 'Center', value: 'center' },
      ],
    },
  ],
}
