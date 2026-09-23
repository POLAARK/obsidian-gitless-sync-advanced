#!/usr/bin/env node
/**
 * Reports whether BRAT can install this plugin right now, by replicating
 * BRAT's own release-selection and asset-lookup logic.
 *
 * BRAT behaviour we mirror (from obsidian42-brat src/features/githubUtils.ts
 * and src/features/BetaPlugins.ts):
 *
 *   - fetchReleaseVersions(): GET /repos/{repo}/releases?per_page=100
 *     (only tag_name/prerelease are needed; assets are NOT used here)
 *   - grabReleaseFromRepository(repo, version, includePrereleases):
 *       version && version !== "latest"
 *         ? GET /repos/{repo}/releases/tags/{version}   // single release
 *         : GET /repos/{repo}/releases                  // array, sort, pick
 *     Sorting: semver.coerce(tag_name) desc, non-semver falls back to
 *     published_at desc, then filter(!prerelease) unless includePrereleases.
 *   - addPlugin() first validates with includePrereleases = true (manifest-beta
 *     attempt), so the effective target is the highest release overall.
 *   - Required assets via `release.assets.find(a => a.name === name)`:
 *       "manifest.json" (validateRepository) and "main.js" (getAllReleaseFiles).
 *       "styles.css" is optional.
 *
 * So this script only reports READY when the release BRAT would pick exposes
 * BOTH "manifest.json" and "main.js" in BOTH endpoints BRAT may call:
 *   - /releases          (used when the version is "latest" / unset)
 *   - /releases/tags/TAG (used when a specific version is chosen)
 *
 * Usage:
 *   node scripts/check-brat-assets.mjs [--repo owner/name] [--tag TAG]
 *        [--interval 300] [--once] [--notify] [--token <PAT>]
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
const forcedTag = typeof arg("tag", "") === "string" ? arg("tag", "") : "";
const interval = Number(arg("interval", 300)) || 300;
const once = has("once");
const notify = has("--notify") || has("notify");
const rawToken = arg("token", process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "");
const token = typeof rawToken === "string" ? rawToken : "";

// BRAT needs manifest.json (validation) and main.js (install).
const REQUIRED_ASSETS = ["manifest.json", "main.js"];

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "gls-brat-asset-check",
};
if (token) {
  headers.Authorization = `Bearer ${token}`;
}

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

async function api(path) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText} ${body.slice(0, 160)}`);
  }
  return res.json();
}

// --- semver.coerce(tag, { includePrerelease: true, loose: true }) analogue ---
function coerce(tag) {
  const m = String(tag)
    .trim()
    .match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?/);
  if (!m) {
    return null;
  }
  return {
    major: +m[1],
    minor: +m[2],
    patch: +m[3],
    pre: m[4] || "",
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  const ap = a.pre ? a.pre.split(".") : [];
  const bp = b.pre ? b.pre.split(".") : [];
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1; // release > prerelease
  if (bp.length === 0) return -1;
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (+x !== +y) return +x - +y;
    } else if (xn) {
      return -1;
    } else if (yn) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// Exactly BRAT's comparator from grabReleaseFromRepository.
function bratCompare(a, b) {
  const av = coerce(a.tag_name);
  const bv = coerce(b.tag_name);
  if (av && bv) {
    return compareSemver(bv, av); // descending
  }
  if (av && !bv) return -1;
  if (!av && bv) return 1;
  const ad = new Date(a.published_at).getTime();
  const bd = new Date(b.published_at).getTime();
  if (ad < bd) return 1;
  if (ad > bd) return -1;
  return 0;
}

function assetNames(release) {
  return (release.assets || []).map((a) => a.name);
}

function missingFrom(names) {
  return REQUIRED_ASSETS.filter((n) => !names.includes(n));
}

async function checkOnce() {
  const releases = await api("/releases?per_page=100");
  if (!Array.isArray(releases) || releases.length === 0) {
    return { ready: false, reason: "no releases found (BRAT: 'no releases available')", rows: [] };
  }

  const sorted = [...releases].sort(bratCompare);
  // addPlugin() tries includePrereleases=true first, so the effective target is
  // the highest release overall (unless the user forces a tag).
  const effective = forcedTag
    ? sorted.find((r) => r.tag_name === forcedTag) || sorted[0]
    : sorted[0];
  const stable = sorted.find((r) => !r.prerelease) || null;

  const listAssets = assetNames(effective);

  let tagAssets = [];
  let tagError = "";
  try {
    tagAssets = assetNames(await api(`/releases/tags/${encodeURIComponent(effective.tag_name)}`));
  } catch (err) {
    tagError = err.message;
  }

  let byIdAssets = [];
  try {
    byIdAssets = assetNames(await api(`/releases/${effective.id}`));
  } catch {
    // diagnostic only
  }
  let latestAssets = [];
  try {
    latestAssets = assetNames(await api("/releases/latest"));
  } catch {
    // diagnostic only
  }

  const listMissing = missingFrom(listAssets);
  const tagsMissing = tagError ? REQUIRED_ASSETS : missingFrom(tagAssets);
  const listOk = listMissing.length === 0;
  const tagsOk = !tagError && tagsMissing.length === 0;
  const ready = listOk && tagsOk;

  return {
    ready,
    effective,
    stable,
    sorted,
    listAssets,
    tagAssets,
    tagError,
    byIdAssets,
    latestAssets,
    listMissing,
    tagsMissing,
    listOk,
    tagsOk,
  };
}

function report(r) {
  console.log("─".repeat(72));
  console.log(`[${stamp()}] repo: ${repo}`);

  console.log("  releases BRAT sees (sorted by BRAT's comparator):");
  for (const rel of r.sorted.slice(0, 6)) {
    console.log(
      `    ${rel.tag_name}${rel.prerelease ? " [pre]" : ""}  published=${(rel.published_at || "").slice(0, 19)}  listAssets=[${assetNames(rel).join(", ")}]`,
    );
  }

  if (r.effective) {
    console.log(`  BRAT target (highest): ${r.effective.tag_name}`);
    console.log(`    /releases            -> [${r.listAssets.join(", ")}]${r.listOk ? "" : `  MISSING: ${r.listMissing.join(", ")}`}`);
    console.log(`    /releases/tags/${r.effective.tag_name} -> [${r.tagAssets.join(", ")}]${r.tagsOk ? "" : `  MISSING: ${r.tagsMissing.join(", ") || r.tagError}`}`);
    console.log(`    /releases/{id}       -> [${r.byIdAssets.join(", ")}]  (cross-check)`);
    console.log(`    /releases/latest     -> [${r.latestAssets.join(", ")}]  (cross-check)`);
  }
  if (r.stable && r.effective && r.stable.tag_name !== r.effective.tag_name) {
    console.log(`  highest stable fallback: ${r.stable.tag_name}`);
  }

  if (r.ready) {
    console.log("  RESULT: READY - BRAT can install (manifest.json + main.js visible in both endpoints).");
  } else if (r.listOk && !r.tagsOk) {
    console.log("  RESULT: PARTIAL - BRAT works if you install 'latest'; picking a specific version would fail.");
  } else if (!r.listOk && r.tagsOk) {
    console.log("  RESULT: PARTIAL - BRAT works if you pick the specific version; 'latest' would fail.");
  } else {
    console.log(`  RESULT: NOT READY - BRAT cannot install yet.`);
  }
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
    `Checking BRAT installability for ${repo}${forcedTag ? ` (tag ${forcedTag})` : ""}; interval ${interval}s${once ? " (single check)" : " until ready"}.`,
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
        console.log("BRAT should now install the plugin successfully.");
        if (notify) {
          osNotify("BRAT can install", `${repo}: release ${result.effective.tag_name} is fully visible to BRAT.`);
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
