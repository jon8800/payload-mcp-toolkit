// Proves dist/ is valid Node ESM, the way a host loads it when Next does not
// bundle the package (`serverExternalPackages`) or plain Node imports it.
// 1. Every relative import in every shipped dist/*.js file names an existing .js
//    file. Node ESM cannot load extensionless paths or .css imports.
// 2. Plain Node can import the server entry point.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const dist = resolve('dist')
if (!existsSync(join(dist, 'index.js'))) {
  console.error('check-dist-esm: dist/index.js is missing. Run `pnpm build` first.')
  process.exit(1)
}

const files = []
;(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') walk(path)
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      files.push(path)
    }
  }
})(dist)

const specifier = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\1/g
const problems = []
for (const file of files) {
  for (const [, , spec] of readFileSync(file, 'utf8').matchAll(specifier)) {
    const target = resolve(dirname(file), spec)
    if (!spec.endsWith('.js')) {
      problems.push(`${relative(dist, file)}: '${spec}' is not a .js file`)
    } else if (!existsSync(target) || !statSync(target).isFile()) {
      problems.push(`${relative(dist, file)}: '${spec}' does not resolve to a file`)
    }
  }
}
if (problems.length > 0) {
  console.error(`check-dist-esm: ${problems.length} relative import(s) Node ESM cannot load:`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}

try {
  const mod = await import(pathToFileURL(join(dist, 'index.js')).href)
  if (typeof mod.mcpToolkitPlugin !== 'function') throw new Error('mcpToolkitPlugin export is missing')
} catch (err) {
  console.error('check-dist-esm: plain Node failed to import dist/index.js')
  console.error(err)
  process.exit(1)
}

console.log(`check-dist-esm: ${files.length} files OK; plain Node imports dist/index.js`)
