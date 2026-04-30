#!/usr/bin/env node
/**
 * Build the static site locally, package dist/ as a gzipped tar,
 * publish it as a GitHub Release asset, and trigger pages.yml to
 * deploy it.
 *
 *   node scripts/deploy.mjs                 # build + release
 *   node scripts/deploy.mjs --skip-build    # release existing dist/
 *   node scripts/deploy.mjs --dry-run       # build + tar, skip upload
 *   node scripts/deploy.mjs --tag pages-foo # custom tag
 *
 * Why split build from deploy:
 *   The static search build emits many shard files and depends on the
 *   release-hosted SQLite corpus. Local builds are faster and more
 *   predictable, so the runner only downloads the prebuilt tarball and
 *   deploys it.
 *
 * One-time repo setup:
 *   Settings → Pages → Source: "GitHub Actions"
 *
 * Why --latest=false:
 *   `npm run db:fetch` resolves the DB asset via "latest release"; if a
 *   pages-* release stole the latest flag, db:fetch would 404. Pages
 *   deploys are looked up by tag in the workflow, so they don't need it.
 *
 * Why workflow_dispatch instead of `release: published`:
 *   The github-pages environment's default protection rule only allows
 *   deployments from the default branch. Release-event runs use the tag
 *   ref and get rejected. workflow_dispatch always runs on the default
 *   branch.
 */
import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist");

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const skipBuild = has("--skip-build");
const dryRun = has("--dry-run");

function utcStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
  );
}

const tag = arg("--tag") || `pages-${utcStamp()}`;
const title = arg("--title") || tag;

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

function shCapture(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", ...opts }).trim();
}

function fileSize(path) {
  return (statSync(path).size / 1024 / 1024).toFixed(1) + " MB";
}

if (!skipBuild) {
  console.log("▸ Building static site");
  sh("npm run build");
} else {
  console.log("▸ Skipping build (--skip-build)");
}

if (!existsSync(DIST) || readdirSync(DIST).length === 0) {
  console.error(`✗ ${DIST} is empty or missing — nothing to deploy.`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "tq-pages-"));
const archive = join(work, "dist.tar.gz");
const shaPath = `${archive}.sha256`;

try {
  console.log(`▸ Packaging ${DIST} → dist.tar.gz`);
  // -C dist ".": pack dist's contents at archive root, no "dist/" prefix.
  // This matches the layout actions/upload-pages-artifact would produce,
  // so the workflow can rename to artifact.tar and feed deploy-pages
  // directly without extracting the static search shard tree on the runner.
  sh(`tar -czf "${archive}" -C "${DIST}" .`);
  console.log(`  → ${fileSize(archive)}`);

  console.log(`▸ Hashing`);
  const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(shaPath, `${sha}  dist.tar.gz\n`);
  console.log(`  sha256: ${sha}`);

  if (dryRun) {
    console.log(`\n(dry run — release not created. Artifact left at ${archive})`);
    process.exit(0);
  }

  const sourceSha = shCapture("git rev-parse --short HEAD");
  const notes = [
    `Pre-built static site for GitHub Pages.`,
    "",
    `- Source: \`${sourceSha}\``,
    `- Archive: ${fileSize(archive)}`,
    `- SHA-256: \`${sha}\``,
    "",
    "Picked up by `.github/workflows/pages.yml` on release publish.",
  ].join("\n");
  const notesPath = join(work, "release-notes.md");
  writeFileSync(notesPath, notes);

  const exists =
    spawnSync("gh", ["release", "view", tag], { cwd: ROOT, stdio: "ignore" })
      .status === 0;

  if (exists) {
    console.log(`▸ Updating existing release ${tag}`);
    sh(`gh release upload "${tag}" "${archive}" "${shaPath}" --clobber`);
    sh(
      `gh release edit "${tag}" --title "${title}" --notes-file "${notesPath}" --latest=false`,
    );
  } else {
    console.log(`▸ Creating release ${tag}`);
    sh(
      `gh release create "${tag}" "${archive}" "${shaPath}" ` +
        `--title "${title}" --notes-file "${notesPath}" --latest=false`,
    );
  }

  console.log(`▸ Triggering pages.yml workflow for ${tag}`);
  sh(`gh workflow run pages.yml --field tag="${tag}"`);
  console.log(`\n✓ Released ${tag} and dispatched deploy workflow`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
