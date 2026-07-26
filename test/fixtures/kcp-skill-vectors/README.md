# kcp-skill conformance vectors (vendored)

Source: https://github.com/Cantara/kcp-skill `vectors/` at **v0.1.0**.

These are the canonical fixtures for producers/consumers of governed
`kind: skill` units. The `expected.json` verdicts are the *linter's*
contract (SK codes); `test/skill-vectors.test.ts` runs the *harness's*
semantics — skill_eligibility and action_scope conformance — over the
same manifests, so drift between what kcp-skill blesses and what this
harness enforces fails CI.

To re-sync after a kcp-skill release:
  cp -r <kcp-skill checkout>/vectors/. test/fixtures/kcp-skill-vectors/
and update the version above.
