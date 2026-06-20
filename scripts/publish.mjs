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

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const { name, version } = pkg

console.log(`Building ${name}@${version}…`)
execSync('pnpm build', { stdio: 'inherit' })

// npm pack prints the tarball filename on its last stdout line.
const tgz = execSync('npm pack --silent', { encoding: 'utf8' }).trim().split('\n').pop()
const buf = readFileSync(tgz)
const integrity = 'sha512-' + createHash('sha512').update(buf).digest('base64')
const shasum = createHash('sha1').update(buf).digest('hex')

// Apply publishConfig (rewrites main/types/exports from src → dist) exactly as
// `npm publish` would, then drop it from the published manifest.
const manifest = {
  ...pkg,
  ...pkg.publishConfig,
  _id: `${name}@${version}`,
  dist: { integrity, shasum, tarball: `https://registry.npmjs.org/${name}/-/${tgz}` },
}
delete manifest.publishConfig

// Guard: the published entry points must resolve to shipped files (dist/), not src/.
if (JSON.stringify({ m: manifest.main, e: manifest.exports }).includes('/src/')) {
  console.error('Refusing to publish: manifest still points at src/. Check publishConfig.')
  process.exit(1)
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
