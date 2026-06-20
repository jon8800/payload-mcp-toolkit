// Before packing, rewrite package.json entry points from src/ (dev) to dist/
// (publish) by applying publishConfig. postpack restores the dev version.
// npm runs this automatically on `npm pack` / `npm publish`, so the tarball a
// consumer installs always points at shipped dist/ files. Self-heals if a
// previous pack crashed mid-swap (recovers from the backup).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const BAK = 'package.json.prepack-bak'
const original = existsSync(BAK) ? readFileSync(BAK, 'utf8') : readFileSync('package.json', 'utf8')
writeFileSync(BAK, original)

const pkg = JSON.parse(original)
if (pkg.publishConfig) {
  Object.assign(pkg, pkg.publishConfig)
  delete pkg.publishConfig
}
writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
