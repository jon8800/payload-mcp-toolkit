import assert from 'node:assert/strict'
import { test } from 'node:test'
import { releaseTarget } from './release-target.mjs'

test('next releases cannot update latest', () => {
  assert.deepEqual(releaseTarget({ name: 'example', version: '0.10.0-next.0' }, 'v0.10.0-next.0'), {
    tag: 'next', filename: 'example-0.10.0-next.0.tgz',
  })
})
test('stable releases keep their explicit latest tag', () => {
  assert.equal(releaseTarget({ name: 'example', version: '0.10.0' }, 'v0.10.0').tag, 'latest')
})
test('mismatched tags and unknown prerelease channels fail before publishing', () => {
  assert.throws(() => releaseTarget({ name: 'example', version: '0.10.0-next.0' }, 'v0.9.0'))
  assert.throws(() => releaseTarget({ name: 'example', version: '0.10.0-rc.1' }))
})
