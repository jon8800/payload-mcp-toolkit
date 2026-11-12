import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function releaseTarget({ name, version }, refName) {
  if (!/^\d+\.\d+\.\d+(?:-next\.\d+)?$/.test(version)) throw new Error(`Unsupported release version: ${version}`)
  if (refName && refName !== `v${version}`) throw new Error(`Tag ${refName} does not match package version ${version}`)
  return { tag: version.includes('-') ? 'next' : 'latest', filename: `${name}-${version}.tgz` }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF_TYPE !== 'tag') throw new Error('Publishing requires a version tag')
  const target = releaseTarget(JSON.parse(readFileSync('package.json', 'utf8')), process.env.GITHUB_REF_NAME)
  const output = `tag=${target.tag}\nfilename=${target.filename}\n`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output)
  console.log(output.trim())
}
