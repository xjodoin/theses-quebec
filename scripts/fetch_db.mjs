#!/usr/bin/env node
/**
 * Download and decompress the latest theses.db release.
 *
 *   node scripts/fetch_db.mjs            # latest release, only if missing locally
 *   node scripts/fetch_db.mjs --force    # re-download even if data/theses.db exists
 *   node scripts/fetch_db.mjs --tag db-2026-04-29
 *
 * Used by:
 *   - scripts/build.mjs (auto-call before building if DB missing)
 *   - .github/workflows/pages.yml (CI step)
 *   - contributors after `git clone` who don't want to re-harvest
 *
 * Verifies the SHA-256 from the sidecar `.sha256` file. Aborts on mismatch.
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = resolve(ROOT, "data/theses.db");
const REPO = "xjodoin/theses-quebec";

const args = process.argv.slice(2);
const arg = (n, fallback = null) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (n) => args.includes(n);

const tag = arg("--tag");                     // null = latest
const force = has("--force");

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

if (existsSync(DEST) && !force) {
  console.log(`✓ ${DEST} already exists (${(statSync(DEST).size / 1024 / 1024).toFixed(1)} MB). Pass --force to redownload.`);
  process.exit(0);
}

mkdirSync(dirname(DEST), { recursive: true });
const work = mkdtempSync(join(tmpdir(), "tq-fetch-"));
const zstPath = join(work, "theses.db.zst");
const shaPath = join(work, "theses.db.zst.sha256");
const tmpDb = join(work, "theses.db");

try {
  // gh release download writes assets to the cwd by default (--dir).
  const tagFlag = tag ? `"${tag}"` : "";
  console.log(`▸ Downloading ${tag || "latest release"} from ${REPO}`);
  sh(`gh release download ${tagFlag} --repo ${REPO} --pattern "theses.db.zst" --pattern "theses.db.zst.sha256" --dir "${work}" --clobber`);

  // Verify SHA-256 before decompressing to catch transport corruption /
  // mismatched assets (e.g. someone re-uploaded one file but not the other).
  const expected = readFileSync(shaPath, "utf8").split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(zstPath)).digest("hex");
  if (expected !== actual) {
    console.error(`✗ SHA mismatch: expected ${expected}, got ${actual}`);
    process.exit(1);
  }
  console.log(`  sha256 ok`);

  console.log(`▸ Decompressing`);
  sh(`zstd -d --long=27 -f -o "${tmpDb}" "${zstPath}"`);

  // Move into place atomically (rename within same FS — fall back to copy
  // when crossing devices, which `mv` would do for us; but keep it simple).
  if (existsSync(DEST)) rmSync(DEST);
  // Cross-device safety: copy if rename fails.
  try { renameSync(tmpDb, DEST); }
  catch {
    sh(`cp "${tmpDb}" "${DEST}"`);
  }
  console.log(`✓ Wrote ${DEST} (${(statSync(DEST).size / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  (FTS5 will be rebuilt on first connect — adds a few seconds.)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
