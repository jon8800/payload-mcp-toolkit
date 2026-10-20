import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve('dist')
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? files(full) : [full]
  })
}

// Native ESM loaders need extensions on local imports, including the public declarations.
for (const file of files(root)) {
  if (/(?:__tests__|fixtures)|\.(?:test|spec)\./.test(path.relative(root, file))) throw new Error(`Test output in dist: ${file}`)
  if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue
  const source = readFileSync(file, 'utf8')
  const output = source.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\.?\/[^'"]*)\2/g,
    (match, prefix, quote, specifier) => {
      if (/\.(?:m?js|cjs|json|s?css)$/.test(specifier)) return match
      const base = path.resolve(path.dirname(file), specifier)
      const target = existsSync(`${base}.js`) ? `${specifier}.js` : existsSync(path.join(base, 'index.js')) ? `${specifier}/index.js` : null
      if (!target) throw new Error(`Unresolved import ${specifier} in ${file}`)
      return `${prefix}${quote}${target}${quote}`
    })
  if (source !== output) writeFileSync(file, output)
}
