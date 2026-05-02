/**
 * Optional seed script for the dev harness.
 *
 * Usage:
 *   pnpm dev:payload run scripts:seed
 *
 * Creates an admin user, a couple of categories/authors, and one sample
 * page + post so the introspection-driven tools have data to work with.
 */
import { getPayload } from 'payload'
import config from './payload.config'

async function seed() {
  const payload = await getPayload({ config })

  await payload.create({
    collection: 'users',
    data: {
      email: 'admin@example.com',
      password: 'password',
      name: 'Admin',
    },
  })

  const tech = await payload.create({
    collection: 'categories',
    data: { name: 'Technology', slug: 'technology', description: 'Tech writing.' },
  })

  const jane = await payload.create({
    collection: 'authors',
    data: { name: 'Jane Doe', slug: 'jane-doe', bio: 'Sample author.' },
  })

  await payload.create({
    collection: 'posts',
    data: {
      title: 'Hello world',
      slug: 'hello-world',
      excerpt: 'A first post.',
      category: tech.id,
      authors: [jane.id],
      featured: true,
      _status: 'published',
    },
  })

  await payload.create({
    collection: 'pages',
    data: {
      title: 'Home',
      slug: 'home',
      _status: 'published',
    },
  })

  // eslint-disable-next-line no-console
  console.log('Seed complete.')
  process.exit(0)
}

seed().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
