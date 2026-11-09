#!/usr/bin/env node
/**
 * Dist-tag guard — points ONE npm dist-tag at ONE existing version for all thirteen published
 * packages, from CI, on npm Trusted Publishing (OIDC). Driven by .github/workflows/dist-tag.yml.
 *
 * It never publishes, never changes a version, and refuses to touch `latest`. Re-running is safe:
 * a package whose tag already points at the version is skipped.
 *
 * Two phases (same shape as publish-guard.mjs):
 *   plan   Validate the inputs; for every package check the version exists, read its current
 *          tags, and for each that still needs the tag run the OIDC token exchange (the call npm
 *          makes before its PUT, without the PUT). Nothing is written. Runs in dry_run too.
 *   apply  Run `npm dist-tag add` per package, collecting EVERY failure (not dying on the first),
 *          then re-read the tags and fail if `latest` moved on any package.
 *
 * What plan CANNOT prove: whether the trusted publisher has "Allow npm dist-tag" enabled. That
 * permission is only enforced on the write, and there is no non-mutating way to probe it. A
 * missing permission therefore surfaces in `apply`, listed for all packages at once with the exact
 * setting to flip. Tagging is idempotent, so a partial run is repaired by re-running.
 *
 * Commands: `plan`, `apply`.  Inputs (env): DIST_TAG, DIST_TAG_VERSION.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLISH_ORDER,
  REGISTRY,
  exchangeOidc,
  getIdToken,
  readPackage
} from "./publish-guard.mjs";

/** npm dist-tag via OIDC needs npm >= 11.21.0 (11.x line) or >= 12.2.0 (12.x line). */
export const DIST_TAG_WORKFLOW_PATH = ".github/workflows/dist-tag.yml";

export const MIN_NPM = { 11: [11, 21, 0], 12: [12, 2, 0] };

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Reject tags npm itself would reject or that `latest` would clobber. npm refuses any tag that is
 * a valid SemVer range — which includes `v1` (it parses as `1.x`), so `npm i pkg@v1` could never
 * select a tag either. This is a conservative superset of that check: anything starting with a
 * digit or a range operator (optionally after `v`/`=`) is refused.
 *
 * @returns {string|undefined} the problem, or undefined if the inputs are acceptable
 */
export function validateInputs({ tag, version }) {
  if (!tag) return "DIST_TAG is empty";
  if (!version) return "DIST_TAG_VERSION is empty";
  if (tag === "latest") return "refusing to move `latest` — this workflow never touches it";
  if (/^[vV=]*\d/.test(tag) || /^[<>~^*xX=]/.test(tag) || tag.trim() !== tag || /\s/.test(tag)) {
    return `tag "${tag}" looks like a SemVer range (npm rejects those, and \`npm i pkg@${tag}\` would resolve as a range, not a tag) — use a name like "opencode-v1"`;
  }
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(tag))
    return `tag "${tag}" has characters npm will not accept`;
  if (!SEMVER.test(version)) return `version "${version}" is not an exact SemVer version`;
  return undefined;
}

/** @param {string} v e.g. "11.21.2" */
export function npmMeetsFloor(v) {
  const parts = v.trim().split(".").map(Number);
  const floor = MIN_NPM[parts[0]];
  if (!floor) return parts[0] > 12;
  for (let i = 0; i < 3; i++) {
    if ((parts[i] ?? 0) > floor[i]) return true;
    if ((parts[i] ?? 0) < floor[i]) return false;
  }
  return true;
}

const encode = (name) => name.replace("/", "%2f");

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  return { status: res.status, body: res.status === 200 ? await res.json() : undefined };
}

/** Public read of the package's dist-tags (no auth needed for public packages). */
export async function readTags({ name, fetch: fetchImpl = fetch, registry = REGISTRY }) {
  const r = await getJson(fetchImpl, `${registry}/-/package/${encode(name)}/dist-tags`);
  if (r.status !== 200) throw new Error(`${name}: dist-tags read returned HTTP ${r.status}`);
  return r.body;
}

/**
 * @returns {Promise<{todo:object[], problems:string[], lines:string[]}>}
 */
export async function plan({
  packages,
  tag,
  version,
  env,
  fetch: fetchImpl = fetch,
  mask = () => {}
}) {
  const todo = [];
  const problems = [];
  const lines = [];
  let idToken;
  for (const pkg of packages) {
    const id = `${pkg.name}@${version}`;
    const v = await getJson(fetchImpl, `${REGISTRY}/${encode(pkg.name)}/${version}`);
    if (v.status === 404) {
      problems.push(`${id}: that version is not on the registry — nothing to tag`);
      continue;
    }
    if (v.status !== 200) {
      problems.push(`${id}: version lookup returned HTTP ${v.status}`);
      continue;
    }
    const tags = await readTags({ name: pkg.name, fetch: fetchImpl });
    if (tags[tag] === version) {
      lines.push(`ok    ${id}: "${tag}" already points here — will skip`);
      continue;
    }
    idToken ??= await getIdToken({ env, fetch: fetchImpl });
    const ex = await exchangeOidc({ name: pkg.name, idToken, fetch: fetchImpl });
    if (!ex.ok) {
      problems.push(
        `${pkg.name}: ${ex.reason}. npm matches the OIDC token to a Trusted Publisher by workflow FILENAME, so this workflow (${DIST_TAG_WORKFLOW_PATH}) needs its OWN Trusted Publisher config on the package (npmjs.com -> package -> Settings -> Trusted Publisher -> GitHub Actions: this repo, workflow dist-tag.yml) with "Allow npm dist-tag" enabled — the publish.yml config does not cover it.`
      );
      continue;
    }
    mask(ex.token);
    const was = tags[tag] ? `currently ${tags[tag]}` : "currently unset";
    lines.push(
      `ok    ${id}: "${tag}" ${was}; OIDC exchange works — will tag (latest stays ${tags.latest})`
    );
    todo.push({ ...pkg, latestBefore: tags.latest });
  }
  return { todo, problems, lines };
}

export function distTagHint(name) {
  return `${name}: \`npm dist-tag add\` failed. Most likely the trusted publisher for dist-tag.yml has "Allow npm dist-tag" OFF (off by default, independent of publish permission): package -> Settings -> Trusted Publisher -> enable "Allow npm dist-tag" on the GitHub Actions config for this repo + dist-tag.yml. Then re-run; tagging is idempotent. See the npm output above for the actual error.`;
}

function npmDistTag(pkg, tag, version) {
  return spawnSync("npm", ["dist-tag", "add", `${pkg.name}@${version}`, tag], { stdio: "inherit" })
    .status;
}

/** @returns {Promise<{tagged:string[], failed:string[], problems:string[]}>} */
export async function apply({ todo, tag, version, fetch: fetchImpl = fetch, run = npmDistTag }) {
  const tagged = [];
  const failed = [];
  const problems = [];
  for (const pkg of todo) {
    const code = run(pkg, tag, version);
    if (code !== 0) {
      failed.push(pkg.name);
      problems.push(distTagHint(pkg.name));
      continue;
    }
    tagged.push(pkg.name);
  }
  // `latest` must not have moved on any package we touched, whether the write succeeded or not.
  for (const pkg of todo) {
    const after = await readTags({ name: pkg.name, fetch: fetchImpl });
    if (after.latest !== pkg.latestBefore) {
      problems.push(
        `${pkg.name}: \`latest\` MOVED from ${pkg.latestBefore} to ${after.latest} during this run`
      );
    }
  }
  return { tagged, failed, problems };
}

export function npmVersion() {
  const r = spawnSync("npm", ["--version"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

export async function main(
  cmd,
  { env = process.env, fetch: fetchImpl = fetch, run, getNpmVersion = npmVersion } = {}
) {
  const tag = env.DIST_TAG ?? "";
  const version = env.DIST_TAG_VERSION ?? "";
  const bad = validateInputs({ tag, version });
  if (bad) {
    console.log(`::error title=Dist-tag inputs::${bad}`);
    return 1;
  }
  if (cmd !== "plan" && cmd !== "apply") {
    console.error("usage: dist-tag.mjs plan|apply");
    return 2;
  }
  const npmV = getNpmVersion();
  if (!npmV || !npmMeetsFloor(npmV)) {
    console.log(
      `::error title=npm too old::npm ${npmV ?? "unknown"} cannot use OIDC for dist-tag; need >= 11.21.0 (11.x) or >= 12.2.0 (12.x). Node 24 bundles an older npm — install npm@^11 first.`
    );
    return 1;
  }
  const packages = PUBLISH_ORDER.map((d) => readPackage(d));
  const p = await plan({
    packages,
    tag,
    version,
    env,
    fetch: fetchImpl,
    mask: (t) => console.log(`::add-mask::${t}`)
  });
  for (const l of p.lines) console.log(l);
  for (const x of p.problems) console.log(`::error title=Dist-tag plan::${x}`);
  if (p.problems.length > 0) {
    console.error(`\nPlan FAILED for ${p.problems.length} package(s). No tag was changed.`);
    return 1;
  }
  console.log(
    `\nPlan passed: ${p.todo.length} to tag, ${packages.length - p.todo.length} already set.`
  );
  if (cmd === "plan") return 0;

  const r = await apply({ todo: p.todo, tag, version, fetch: fetchImpl, run });
  console.log(`Tagged ${r.tagged.length}: ${r.tagged.join(", ") || "-"}`);
  for (const x of r.problems) console.log(`::error title=Dist-tag apply::${x}`);
  if (r.problems.length > 0) {
    console.error(
      `\nApply finished with ${r.failed.length} failed package(s). Re-run after fixing; it is idempotent.`
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then(
    (code) => process.exit(code),
    (err) => {
      console.log(`::error title=Dist-tag::${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  );
}
