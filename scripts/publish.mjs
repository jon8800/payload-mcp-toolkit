// Publish via a raw authenticated PUT.
// ponytail: `npm publish` 403s on this account (security-key-only 2FA + the
// package's 2FA lock collides with npm's CLI OTP flow). The registry accepts a
// plain authenticated PUT with a bypass-2FA token, which is all this does — the
// same request npm builds internally, minus the broken 2FA negotiation.
// Token comes from NPM_TOKEN (CI secret) or ~/.npmrc; it is never printed.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const token =
  process.env.NPM_TOKEN?.trim() ||
  readFileSync(join(homedir(), '.npmrc'), 'utf8').match(/_authToken=(.+)/)?.[1]?.trim()
if (!token) {
  console.error('No token: set NPM_TOKEN or add _authToken to ~/.npmrc')
  process.exit(1)
}

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'))

console.log(`Building ${name}@${version}…`)
execSync('pnpm build', { stdio: 'inherit' })

// npm pack runs prepack/postpack, which rewrite the tarball's package.json
// entry points from src/ to dist/. The last stdout line is the tarball name.
const tgz = execSync('npm pack --silent', { encoding: 'utf8' }).trim().split('\n').pop()
const buf = readFileSync(tgz)

// Derive the published manifest from the *actual* tarball package.json, so the
// registry metadata can never drift from what a consumer installs.
const manifest = JSON.parse(execSync(`tar -xzO -f ${tgz} package/package.json`, { encoding: 'utf8' }))

// Guard: entry points must resolve to shipped files (dist/), never src/.
if ((String(manifest.main) + JSON.stringify(manifest.exports ?? '')).includes('/src/')) {
  console.error('Refusing to publish: tarball package.json still points at src/. Check prepack/publishConfig.')
  process.exit(1)
}

manifest._id = `${name}@${version}`
manifest.dist = {
  integrity: 'sha512-' + createHash('sha512').update(buf).digest('base64'),
  shasum: createHash('sha1').update(buf).digest('hex'),
  tarball: `https://registry.npmjs.org/${name}/-/${tgz}`,
}

const body = {
  _id: name,
  name,
  'dist-tags': { latest: version },
  versions: { [version]: manifest },
  _attachments: {
    [tgz]: { content_type: 'application/octet-stream', data: buf.toString('base64'), length: buf.length },
  },
}

const res = await fetch(`https://registry.npmjs.org/${name}`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

if (!res.ok) {
  console.error(`Publish failed: ${res.status} ${res.statusText}\n${await res.text()}`)
  process.exit(1)
}
console.log(`Published ${name}@${version}`)
