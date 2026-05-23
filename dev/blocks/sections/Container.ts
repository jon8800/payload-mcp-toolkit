import type { Block } from 'payload'
import { Heading } from '../leaves/Heading'
import { RichText } from '../leaves/RichText'
import { ImageBlock } from '../leaves/ImageBlock'
import { ButtonGroup } from '../leaves/ButtonGroup'
import { Quote } from '../leaves/Quote'
import { TwoColumn } from './TwoColumn'
import { FullWidth } from './FullWidth'
import { CtaBanner } from './CtaBanner'
import { HeadingOnly } from './HeadingOnly'

const allLeaves = [Heading, RichText, ImageBlock, ButtonGroup, Quote]
const childSections = [TwoColumn, FullWidth, CtaBanner, HeadingOnly]

export const Container: Block = {
  slug: 'container',
  fields: [
    {
      name: 'label',
      type: 'text',
    },
    {
      name: 'sections',
      type: 'blocks',
      blocks: [...childSections, ...allLeaves],
    },
    {
      name: 'spacing',
      type: 'select',
      defaultValue: 'normal',
      options: [
        { label: 'Tight', value: 'tight' },
        { label: 'Normal', value: 'normal' },
        { label: 'Loose', value: 'loose' },
      ],
    },
  ],
}
