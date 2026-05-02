import type { Block } from 'payload'
import { Heading } from './leaves/Heading'
import { RichText } from './leaves/RichText'
import { ImageBlock } from './leaves/ImageBlock'
import { ButtonGroup } from './leaves/ButtonGroup'
import { Quote } from './leaves/Quote'
import { FullWidth } from './sections/FullWidth'
import { TwoColumn } from './sections/TwoColumn'
import { CtaBanner } from './sections/CtaBanner'
import { HeadingOnly } from './sections/HeadingOnly'

export const allLeafBlocks: Block[] = [Heading, RichText, ImageBlock, ButtonGroup, Quote]
export const allSectionBlocks: Block[] = [FullWidth, TwoColumn, CtaBanner, HeadingOnly]
