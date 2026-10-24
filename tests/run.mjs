// Bundles the tests with "obsidian" mapped to a stub, then runs them with node:test.
import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "gsync-test-")), "sync.test.mjs");
await esbuild.build({
  entryPoints: ["tests/sync.test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: out,
  alias: { obsidian: "./tests/obsidian-stub.ts" },
  logLevel: "warning",
});
const r = spawnSync(process.execPath, ["--test", out], { stdio: "inherit" });
process.exit(r.status ?? 1);
