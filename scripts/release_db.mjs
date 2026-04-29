#!/usr/bin/env node
/**
 * Publish data/theses.db as a GitHub Release asset.
 *
 *   node scripts/release_db.mjs            # tag = db-YYYY-MM-DD
 *   node scripts/release_db.mjs --tag db-2026-04-29
 *   node scripts/release_db.mjs --dry-run  # build the artifact, skip upload
 *
 * Why a release instead of LFS:
 *   The harvested DB is ~666 MB with FTS5, ~440 MB without. GitHub LFS free
 *   tier is 1 GB storage + 1 GB/month bandwidth — every commit version
 *   accumulates, and every Pages build re-downloads. Releases don't count
 *   against LFS quota; assets up to 2 GB.
 *
 * Pipeline:
 *   1. Copy data/theses.db → temp file
 *   2. `slim_db()` (Python) drops FTS5 + VACUUM → ~440 MB
 *   3. zstd -19 → ~120-180 MB
 *   4. sha256 alongside, for integrity check on download
 *   5. `gh release create db-YYYY-MM-DD --latest theses.db.zst theses.db.zst.sha256`
 *
 * Consumers (`scripts/fetch_db.mjs`) download the latest tagged release,
 * verify SHA, and decompress to data/theses.db. The first connect() then
 * rebuilds FTS5 transparently (see harvester/db.py).
 */
import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, statSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolve(ROOT, "data/theses.db");

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const dryRun = has("--dry-run");
const today = new Date().toISOString().slice(0, 10);
const tag = arg("--tag") || `db-${today}`;
const title = arg("--title") || `Theses DB ${today}`;

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

function shPipe(cmd) {
  return execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
}

function fileSize(path) {
  return (statSync(path).size / 1024 / 1024).toFixed(1) + " MB";
}

// ---------- 1 + 2 + 3: build the artifact ---------------------------------
if (!statSync(SRC, { throwIfNoEntry: false })) {
  console.error(`✗ ${SRC} not found — run the harvester first.`);
  process.exit(1);
}
console.log(`▸ Source: ${SRC} (${fileSize(SRC)})`);

const work = mkdtempSync(join(tmpdir(), "tq-release-"));
const slimPath = join(work, "theses.db");
const zstPath = join(work, "theses.db.zst");
const shaPath = join(work, "theses.db.zst.sha256");

try {
  console.log(`▸ Copying to ${slimPath}`);
  copyFileSync(SRC, slimPath);

  console.log(`▸ Stripping FTS5 + VACUUM`);
  sh(`.venv/bin/python -c "import sys; sys.path.insert(0, 'harvester'); from db import slim_db; slim_db('${slimPath}')"`);
  console.log(`  → ${fileSize(slimPath)}`);

  console.log(`▸ Compressing (zstd -19)`);
  sh(`zstd -19 --long=27 -f -o "${zstPath}" "${slimPath}"`);
  console.log(`  → ${fileSize(zstPath)}`);

  console.log(`▸ Hashing`);
  const sha = createHash("sha256").update(readFileSync(zstPath)).digest("hex");
  writeFileSync(shaPath, `${sha}  theses.db.zst\n`);
  console.log(`  sha256: ${sha}`);

  // ---------- 4: upload via gh CLI ----------------------------------------
  if (dryRun) {
    console.log(`\n(dry run — release not created. Artifact left at ${zstPath})`);
    process.exit(0);
  }

  // `gh release view` returns non-zero if the tag doesn't exist yet (the
  // common case). spawnSync's status check swallows that cleanly.
  const exists = spawnSync("gh", ["release", "view", tag], { cwd: ROOT, stdio: "ignore" }).status === 0;

  // Notes go through a tempfile, not --notes "...". The body has backticks
  // (markdown code spans) which the shell would otherwise interpret as
  // command substitution; --notes-file sidesteps the shell entirely.
  const recordCount = shPipe(`.venv/bin/python -c "import sqlite3; print(sqlite3.connect('${slimPath}').execute('SELECT COUNT(*) FROM theses').fetchone()[0])"`);
  const notes = [
    "Slim, zstd-compressed snapshot of `data/theses.db`.",
    "",
    `- Records: ${recordCount}`,
    `- Compressed: ${fileSize(zstPath)}`,
    `- Decompressed: ${fileSize(slimPath)}`,
    `- SHA-256: \`${sha}\``,
    "",
    "Decompress with `zstd -d theses.db.zst` (or run `npm run db:fetch` from the repo).",
  ].join("\n");
  const notesPath = join(work, "release-notes.md");
  writeFileSync(notesPath, notes);

  if (exists) {
    console.log(`▸ Updating existing release ${tag}`);
    sh(`gh release upload "${tag}" "${zstPath}" "${shaPath}" --clobber`);
    sh(`gh release edit "${tag}" --title "${title}" --notes-file "${notesPath}" --latest`);
  } else {
    console.log(`▸ Creating release ${tag}`);
    sh(`gh release create "${tag}" "${zstPath}" "${shaPath}" --title "${title}" --notes-file "${notesPath}" --latest`);
  }
  console.log(`\n✓ Released ${tag}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
