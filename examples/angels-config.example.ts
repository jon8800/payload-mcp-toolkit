/**
 * Example: site-specific configuration for the Angels Escorts website.
 *
 * This file is **not** exported from the package — it lives here as a
 * reference for how to build a `ContentToolkitOptions` factory tailored
 * to your own CMS. Copy the pattern into your own project, swap the
 * vocabulary and draft policy, and pass the result to `mcpToolkitPlugin`.
 */
import type { ContentToolkitOptions, DomainPrompt } from 'payload-mcp-toolkit'

const angelsPrompts: DomainPrompt[] = [
  {
    name: 'angelsBusinessVocabulary',
    title: 'Angels Escorts Business Vocabulary',
    description: 'Explains site-specific terms and workflows for the Angels Escorts website',
    content: [
      'This is an escort agency website. Key terminology:',
      '',
      '- "Model" = an escort profile in the Models collection',
      '- "Featured" = setting the `featured` checkbox to true on a Model makes them appear prominently on the homepage',
      '- "Available today" = the `availableToday` checkbox indicates the model is currently accepting bookings',
      '- "Touring" = the `touring` relationship field (single, to Locations) indicates the model is temporarily available in a different city',
      '- "Locations" = cities where models are based (e.g., Melbourne, Sydney, Brisbane)',
      '- "Services" = types of companionship offered (linked to models via hasMany relationship)',
      '- "Categories" = classification of model types (linked via hasMany relationship)',
      '',
      'Common workflows:',
      '- To feature a model: update the Model document with `featured: true`',
      '- To mark as available: update with `availableToday: true`',
      '- To set touring location: update the `touring` relationship to a Location document ID',
      '- To add rates: update the `rates` array with objects containing `serviceType`, `duration`, and `price`',
      '- To create a model: provide at minimum `name` and `slug` (unique). Upload a profile image via the uploadMedia tool first.',
    ].join('\n'),
  },
  {
    name: 'angelsRatesGuide',
    title: 'Model Rates Structure',
    description: 'Explains how to structure model pricing/rates data',
    content: [
      'Model rates are stored as an array field called `rates` on the Models collection.',
      'Each rate entry has:',
      '  - `serviceType` (text): e.g., "Social", "GFE", "PSE", "WPSE"',
      '  - `duration` (text): e.g., "30 Minutes", "1 Hour", "2 Hours", "3 Hours", "Overnight"',
      '  - `price` (number): the rate in AUD, e.g., 500, 800, 1200',
      '',
      'Example rates for a model:',
      '  [',
      '    { serviceType: "Social", duration: "1 Hour", price: 500 },',
      '    { serviceType: "GFE", duration: "1 Hour", price: 800 },',
      '    { serviceType: "GFE", duration: "2 Hours", price: 1200 },',
      '  ]',
    ].join('\n'),
  },
]

/**
 * Site-specific options for the Angels Escorts CMS.
 *
 * Notes for adapting this to your own site:
 * - `serverURL` on your `buildConfig()` is what the toolkit reads as the
 *   absolute base for preview URLs — set it there, not here.
 * - Preview URL paths come from each collection's own `admin.livePreview.url`
 *   (e.g. `models` → `/models/${slug}`). Configure them on the collection
 *   itself; this file only carries vocabulary and overrides.
 * - Draft behavior is inferred from `versions.drafts`. The override map
 *   below is only needed if you specifically want raw publish on a draftable
 *   collection — usually you can drop this property entirely.
 */
export function createAngelsConfig(): ContentToolkitOptions {
  return {
    domainPrompts: angelsPrompts,
    mediaUpload: {
      maxFileSize: 10 * 1024 * 1024, // 10MB
    },
    exclude: {
      collections: ['form-uploads'],
    },
  }
}
