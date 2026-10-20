# Payload 4 prerelease

Candidate: `payload-mcp-toolkit@0.10.0-next.1`, for Payload `4.0.0-beta.3` only.

Source commit `e93686c` is already pushed on `release/payload-v4-next`. Its `v0.10.0-next.0` tag failed before publication because the workflow specified two conflicting pnpm versions. Keep that tag unchanged. This recovery removes the redundant workflow input and prepares a new immutable version tag.

## Validation

Run from this worktree with pnpm. `pnpm-workspace.yaml` selects Node `24.15.0`.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node --test scripts/release-target.test.mjs
pnpm build
pnpm exec npm pack --silent
```

The package and dev app typechecks passed. All 413 plugin tests passed. All 3 release-channel tests passed. The build excludes tests and fixtures before SWC emits files. Its final step adds explicit extensions to local ESM imports. The compiled server export loads in native Node.

The inspected tarball contains 140 files. All public exports point to existing `dist` files. It contains no test, fixture, source, dev, environment, or dependency folders. Packing restores the source manifest after applying the existing `publishConfig` entry points.

## Publishing

After review, commit this recovery and push tag `v0.10.0-next.1`. The existing GitHub publish workflow uses the repository's `NPM_TOKEN` secret. No secret values are needed in chat or local files.

The workflow checks the version tag before calling `scripts/publish.mjs`. The raw publisher independently repeats the check. It derives `next` from the prerelease version and refuses a conflicting `NPM_TAG`. Its registry request updates only that npm tag. The existing stable `latest` tag stays on `0.9.0`.

The parent task must check the new archive in the combined consumer before release. The recovery changes remain uncommitted and unpushed. This preparation does not alter existing tags or publish anything.
