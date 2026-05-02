/**
 * Optional seed script for the dev harness.
 *
 * Usage:
 *   pnpm dev:payload run scripts:seed
 *
 * Creates an admin user, a couple of categories/authors, and one sample
 * page + post so the introspection-driven tools have data to work with.
 */
import { writeFileSync } from 'node:fs'
import { getPayload } from 'payload'
import config from './payload.config.js'

function logProgress(msg: string) {
  // payload run swallows console output; mirror to a file so we can verify
  writeFileSync('seed-progress.log', msg + '\n', { flag: 'a' })
}

async function seed() {
  logProgress('seed: starting')
  const payload = await getPayload({ config })
  logProgress('seed: payload booted')

  const existingUser = await payload.find({
    collection: 'users',
    where: { email: { equals: 'admin@example.com' } },
    limit: 1,
  })

  if (existingUser.totalDocs === 0) {
    await payload.create({
      collection: 'users',
      data: {
        email: 'admin@example.com',
        password: 'password',
        name: 'Admin',
      },
    })
    logProgress('seed: admin user created')
  } else {
    logProgress('seed: admin user already exists, skipping')
  }

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

  logProgress('seed: complete')
  process.exit(0)
}

seed().catch((err) => {
  writeFileSync('seed-error.log', String(err?.stack || err))
  process.exit(1)
})
