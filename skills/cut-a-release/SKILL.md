# Cut a release

Governed skill: cut a kcp-harness release through its two-workflow handoff without skipping
a step or double-tagging.

## Preconditions
- `main` is green (CI passing) at the commit you intend to release.
- You know the target version (semver) and it is NOT already tagged
  (`git ls-remote --tags origin` to check).

## Steps
1. **(edit)** Bump `version` in `package.json` on a `chore(release): vX.Y.Z` commit merged to
   `main` first. `release.yml` does not do this for you, and `ci.yml`'s publish step ships
   whatever `package.json` says at publish time.
2. **(bash)** Trigger `release.yml` via
   `gh workflow run release.yml -f version=vX.Y.Z -f target=main` (or the Actions UI). This one
   workflow tags, cross-compiles native binaries for 5 targets, smoke-tests linux-x64, creates
   the GitHub release with binaries + `SHA256SUMS.txt` attached, and — as its LAST step —
   dispatches `ci.yml` on `main` for npm publish. Do not tag manually first: the workflow checks
   for an existing tag and no-ops the tag step if one is already pushed, but a hand-pushed tag
   just adds a race with no benefit.
3. **(read)** Watch the `release` run to completion, then confirm `ci.yml`'s `publish` job
   (triggered by that hand-off, not by the tag push) went green.

## Verification
`npm view kcp-harness version` equals the tag you cut, the GitHub release has 5 binaries plus
`SHA256SUMS.txt`, and the `ci.yml` `publish` job dispatched by `release.yml` is green.

## Rollback
If the tag/release built but npm publish failed: fix forward, do not delete or move the pushed
tag — re-run `ci.yml` via `workflow_dispatch` once the issue is fixed. If step 1 was skipped
(version not bumped): `npm publish --provenance` will fail as a duplicate version — bump
`package.json`, commit to `main`, and re-dispatch `ci.yml`.
