# Resign knowledge.yaml

Governed skill: recover from an invalidated `knowledge.yaml.sig` after editing `knowledge.yaml`
on a PR branch — this repo's own test suite verifies that signature, so an unsigned edit
self-blocks its own PR, and a merge to `main` cannot fix a check that is already blocking
the merge.

## Preconditions
- `knowledge.yaml` was edited on a branch that is NOT `main`/`master` (a push to `main` triggers
  `sign-kcp.yml` automatically — this skill is for the PR-branch case, where that `push` trigger
  never fires).
- You have permission to dispatch workflows on this repo; the signing key itself lives in
  `Cantara/.github` and is reached via `secrets: inherit`, not held locally.

## Steps
1. **(read)** Confirm this is the actual failure: CI red on the manifest-signature check, and
   `knowledge.yaml` (not just `.sig`) was touched in the diff.
2. **(bash)** `gh workflow run sign-kcp.yml --ref <your-branch>` — its `workflow_dispatch`
   trigger exists specifically so the manifest can be re-signed against a PR branch on demand,
   not just against `main`.
3. **(bash)** Wait for the run to finish, then `git pull` on your branch — the workflow commits
   the refreshed `knowledge.yaml.sig` back to the branch it ran against.
4. **(read)** Re-run or re-check CI on the PR; confirm the signature check is now green.

## Verification
`knowledge.yaml.sig` on the branch has a new commit from the signing workflow, and the
manifest-signature CI check is green on the PR.

## Rollback
If the dispatch fails or the signing secret is unavailable to your branch: do not hand-edit
`knowledge.yaml.sig` or weaken signature verification to unblock the PR — page whoever holds
the `Cantara/.github` signing secret instead.
