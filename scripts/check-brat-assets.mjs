#!/usr/bin/env node
/**
 * Polls the GitHub Releases API to detect when a release's assets become
 * visible to BRAT again.
 *
 * Background: BRAT reads release assets from the REST endpoints
 * `/repos/{owner}/{repo}/releases` and `/repos/{owner}/{repo}/releases/tags/{tag}`.
 * Right now GitHub serves an empty `assets` array from those two endpoints for
 * recently created releases, while `/releases/latest`, `/releases/{id}` and
 * the GraphQL API still return the assets. This script reports the difference
 * and exits 0 as soon as BRAT would be able to see `manifest.json` + `main.js`.
 *
 * Usage:
 *   node scripts/check-brat-assets.mjs [--repo owner/name] [--interval 300]
 *                                      [--once] [--notify] [--token <PAT>]
 *
 * Token can also be provided via GITHUB_TOKEN or GH_TOKEN. Without a token the
 * requests are unauthenticated (60/hour), which is plenty for occasional checks.
 */

import { execFile } from "node:child_process";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) {
    return fallback;
  }
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : true;
};

const repo = arg("repo", process.env.GLS_REPO || "POLAARK/obsidian-gitless-sync-advanced");
const interval = Number(arg("interval", 300)) || 300;
const once = has("once");
const notify = has("notify");
const rawToken = arg("token", process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "");
const token = typeof rawToken === "string" ? rawToken : "";

const REQUIRED_ASSETS = ["main.js", "manifest.json"];

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "gls-brat-asset-check",
};
if (token) {
  headers.Authorization = `Bearer ${token}`;
}

const stamp = () =>
  new Date().toISOString().replace("T", " ").slice(0, 19);

async function api(path) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText} ${body.slice(0, 160)}`);
  }
  return res.json();
}

function parseVersion(tag) {
  const m = String(tag).match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) {
    return { nums: [-1, -1, -1], pre: "", raw: String(tag) };
  }
  return { nums: [+m[1], +m[2], +m[3]], pre: m[4] || "", raw: String(tag) };
}

function compareDesc(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) {
      return b.nums[i] - a.nums[i];
    }
  }
  // Stable releases before pre-releases, matching BRAT's default ordering.
  const aPre = a.pre ? 1 : 0;
  const bPre = b.pre ? 1 : 0;
  if (aPre !== bPre) {
    return aPre - bPre;
  }
  return String(b.pre).localeCompare(String(a.pre));
}

async function checkOnce() {
  const releases = await api("/releases?per_page=100");
  if (!Array.isArray(releases) || releases.length === 0) {
    return { ready: false, reason: "no releases found", rows: [] };
  }

  const sorted = [...releases].sort((a, b) =>
    compareDesc(parseVersion(a.tag_name), parseVersion(b.tag_name)),
  );
  const target = sorted[0];

  const rows = sorted.slice(0, 5).map((r) => ({
    tag: r.tag_name,
    draft: !!r.draft,
    published: (r.published_at || "").slice(0, 19),
    listAssets: (r.assets || []).map((a) => a.name),
  }));

  let byId = [];
  try {
    byId = ((await api(`/releases/${target.id}`)).assets || []).map((a) => a.name);
  } catch {
    // ignore, diagnostic only
  }
  let latest = [];
  try {
    latest = ((await api("/releases/latest")).assets || []).map((a) => a.name);
  } catch {
    // ignore, diagnostic only
  }

  const tagAssets = (target.assets || []).map((a) => a.name);
  const ready = REQUIRED_ASSETS.every((name) => tagAssets.includes(name));
  return {
    ready,
    target: target.tag_name,
    rows,
    tagAssets,
    byId,
    latest,
    reason: ready
      ? ""
      : `release ${target.tag_name} is invisible to BRAT (list/tags assets: [${tagAssets.join(", ")}])`,
  };
}

function report(result) {
  console.log("─".repeat(68));
  console.log(`[${stamp()}] repo: ${repo}`);
  for (const row of result.rows) {
    console.log(
      `  ${row.tag}  published=${row.published}  draft=${row.draft}  listAssets=[${row.listAssets.join(", ")}]`,
    );
  }
  if (result.target) {
    console.log(`  target (highest version): ${result.target}`);
    console.log(`  list/tags assets: [${(result.tagAssets || []).join(", ")}]`);
    console.log(`  by-id assets:     [${(result.byId || []).join(", ")}]`);
    console.log(`  latest assets:    [${(result.latest || []).join(", ")}]`);
  }
  console.log(
    result.ready
      ? "  RESULT: BRAT-visible assets PRESENT"
      : `  RESULT: not yet visible to BRAT - ${result.reason}`,
  );
}

function osNotify(title, message) {
  if (process.platform !== "darwin") {
    return;
  }
  execFile(
    "osascript",
    ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`],
    () => {},
  );
}

async function main() {
  if (!token) {
    console.log("note: no token provided, using unauthenticated requests (60/hour).");
  }
  console.log(
    `Polling ${repo} every ${interval}s${once ? " (single check)" : " until fixed"}. Ctrl-C to stop.`,
  );

  for (;;) {
    let result = null;
    try {
      result = await checkOnce();
    } catch (err) {
      console.error(`[${stamp()}] error: ${err.message}`);
    }

    if (result) {
      report(result);
      if (result.ready) {
        console.log(
          "GitHub is exposing the assets again. BRAT should now be able to install the plugin.",
        );
        if (notify) {
          osNotify("BRAT assets visible", `${repo}: BRAT can install the plugin again.`);
        }
        process.exit(0);
      }
    }

    if (once) {
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(10, interval) * 1000));
  }
}

main();
