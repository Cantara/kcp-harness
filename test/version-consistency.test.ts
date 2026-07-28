// The version is stamped in four places: package.json, the CLI banner, and the harness
// version reported to downstream servers and by the proxy. Nothing tied them together, so a
// release that bumped package.json and missed one would ship a proxy announcing a version it
// is not — and the value is used for interop reporting, where being wrong is worse than
// being absent.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const pkgVersion = (JSON.parse(read("package.json")) as { version: string }).version;

describe("every stamped version matches package.json", () => {
  for (const [file, pattern] of [
    ["src/cli.ts", /const VERSION = "([\d.]+)"/],
    ["src/downstream.ts", /const HARNESS_VERSION = "([\d.]+)"/],
    ["src/proxy.ts", /const HARNESS_VERSION = "([\d.]+)"/],
  ] as const) {
    it(`${file} stamps ${pkgVersion}`, () => {
      const m = read(file).match(pattern);
      expect(m, `no version literal found in ${file}`).toBeTruthy();
      expect(m![1], `${file} vs package.json`).toBe(pkgVersion);
    });
  }
});

// The manifest version tracked package.json exactly until 0.4.2 — the commit that set it
// says "bump to 0.4.2" and moves both — and then stopped while the package went to 0.10.x.
// Six minors of the repo describing itself as an older release to anything that read its
// manifest, which is the one thing a self-describing repo must not get wrong.
describe("the repo's own manifest declares the package version", () => {
  it("knowledge.yaml version matches package.json", () => {
    const declared = read("knowledge.yaml").match(/^version:\s*"?([\d.]+)"?/m);
    expect(declared, "knowledge.yaml has no version").toBeTruthy();
    expect(declared![1], `knowledge.yaml ${declared?.[1]} vs package.json ${pkgVersion}`).toBe(pkgVersion);
  });
});
