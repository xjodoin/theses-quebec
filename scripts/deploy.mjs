#!/usr/bin/env node
/**
 * Build the static site locally, package dist/ as a gzipped tar, and
 * publish it as a GitHub Release asset. The repo workflow
 * `.github/workflows/pages.yml` listens for `pages-*` releases and hands
 * the asset to actions/deploy-pages.
 *
 *   node scripts/deploy.mjs                 # build + release
 *   node scripts/deploy.mjs --skip-build    # release existing dist/
 *   node scripts/deploy.mjs --dry-run       # build + tar, skip upload
 *   node scripts/deploy.mjs --tag pages-foo # custom tag
 *
 * Why split build from deploy:
 *   Pagefind's writeFiles emits 187k+ small fragment files into one
 *   directory; GitHub-hosted runners' shared disk stalls (~22 min, hits
 *   the job timeout). Local NVMe finishes in ~3 min. So we build local
 *   and the runner does only the cheap part: download + deploy.
 *
 * One-time repo setup:
 *   Settings → Pages → Source: "GitHub Actions"
 *
 * Why --latest=false:
 *   `npm run db:fetch` resolves the DB asset via "latest release"; if a
 *   pages-* release stole the latest flag, db:fetch would 404. Pages
 *   deploys are looked up by tag in the workflow, so they don't need it.
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
  // directly without re-extracting 187k files.
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
  console.log(`\n✓ Released ${tag} — pages.yml will pick it up`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
