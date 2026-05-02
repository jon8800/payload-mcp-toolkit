import type { Block } from 'payload'

export const Quote: Block = {
  slug: 'quote',
  fields: [
    { name: 'text', type: 'textarea', required: true },
    { name: 'attribution', type: 'text' },
    { name: 'role', type: 'text' },
  ],
}
