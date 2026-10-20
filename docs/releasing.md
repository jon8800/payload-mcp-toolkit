# Payload 4 prerelease

Candidate: `payload-mcp-toolkit@0.10.0-next.0`, for Payload `4.0.0-beta.3` only.

This worktree starts at `d43b283` on `release/payload-v4-next`. The original checkout and the npm `latest` tag remain unchanged.

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

After review, commit this worktree and push tag `v0.10.0-next.0`. The existing GitHub publish workflow uses the repository's `NPM_TOKEN` secret. No secret values are needed in chat or local files.

The workflow checks the version tag before calling `scripts/publish.mjs`. The raw publisher independently repeats the check. It derives `next` from the prerelease version and refuses a conflicting `NPM_TAG`. Its registry request updates only that npm tag. The existing stable `latest` tag stays on `0.9.0`.

The parent task must complete the combined consumer build before release. This preparation does not commit, push, tag, or publish anything.
