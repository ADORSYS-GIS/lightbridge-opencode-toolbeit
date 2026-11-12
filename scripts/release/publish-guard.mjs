#!/usr/bin/env node
/**
 * Release publish guard — the one place that knows WHICH packages publish, in WHAT order, and
 * whether this pipeline is allowed to SKIP one.
 *
 * Why it exists (see CHANGELOG [Unreleased], runs 33864587568 / 42573812315): the old workflow
 * skipped any package whose version was "already on npm". A version that reached npm by hand has
 * no Trusted Publisher behind it, so the skip hid a package this pipeline could not publish for
 * two months. The skip is still needed (it makes a re-run after a partial failure safe), so it is
 * now conditional on the registry's own evidence that THIS workflow published that version:
 *
 *   absent    version not on the registry          → must publish (needs a working OIDC exchange)
 *   pipeline  has a SLSA provenance attestation     → published by this repo's publish.yml; skip
 *             whose workflow is this repo's
 *             .github/workflows/publish.yml
 *   foreign   on the registry WITHOUT that proof    → hard failure, never a skip
 *
 * Two phases, both driven from publish.yml:
 *
 *   preflight  before anything is packed or pushed: classify all packages, and for every one that
 *              still has to publish, run the npm OIDC token exchange (the exact call pnpm makes
 *              before its PUT, but with no PUT). A release goes out whole or not at all.
 *   publish    the ordered loop. Re-classifies each package (so the skip decision is made against
 *              live state, not the preflight snapshot) and publishes the absent ones.
 *
 * Commands: `list` (short names, publish order), `preflight`, `publish`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Publish order, by directory under `packages/`. Dependencies first: `auth-core`, `core-otel`,
 * `provider-sync` before anything that depends on them; `lightbridge` last. The test suite
 * checks this list against the workspace (every non-private package, dependency-safe order), so
 * adding a package without adding it here fails CI instead of silently never publishing.
 */
export const PUBLISH_ORDER = [
  "opencode-auth-core",
  "opencode-core-otel",
  "opencode-provider-sync",
  "opencode-repo-auth",
  "opencode-oauth2",
  "opencode-models-info",
  "opencode-ratelimit",
  "opencode-browser",
  "opencode-browser-mcp",
  "opencode-devtools",
  "opencode-devtools-mcp",
  "opencode-github-notify",
  "opencode-otel",
  "opencode-lightbridge"
];

export const REGISTRY = "https://registry.npmjs.org";
export const PUBLISH_WORKFLOW_PATH = ".github/workflows/publish.yml";
const SLSA_PREDICATE = "https://slsa.dev/provenance/v1";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "..", "..");

/** @param {string} dir */
export function readPackage(dir, root = REPO_ROOT) {
  const pkg = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
  return { dir, name: pkg.name, version: pkg.version };
}

/** `@vymalo/opencode-x` → `dist-tarball` folder name `x`. */
export function shortName(name) {
  return name.replace(/^@vymalo\/opencode-/, "");
}

/** Scoped names need the slash encoded in registry URLs: `@vymalo%2fopencode-x`. */
function registryPath(name) {
  return name.replace("/", "%2f");
}

async function fetchWithRetry(fetchImpl, url, init, { sleep, attempts = 3 }) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchImpl(url, init);
      if (res.status < 500) return res;
      last = new Error(`HTTP ${res.status} from ${url}`);
    } catch (err) {
      last = err;
    }
    if (i < attempts - 1) await sleep(1000 * 2 ** i);
  }
  throw last;
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Decide what the registry says about `name@version`. Fails CLOSED: anything that is not a clean
 * 404 (absent) or a clean 200 is an exception, never "absent" and never "pipeline".
 *
 * @returns {Promise<{state:"absent"|"pipeline"|"foreign", reason:string}>}
 */
export async function classifyVersion({
  name,
  version,
  repository,
  fetch: fetchImpl = fetch,
  sleep = realSleep,
  registry = REGISTRY
}) {
  const opts = { sleep };
  const accept = { headers: { Accept: "application/json" } };
  const res = await fetchWithRetry(
    fetchImpl,
    `${registry}/${registryPath(name)}/${version}`,
    accept,
    opts
  );
  if (res.status === 404) return { state: "absent", reason: "version not on the registry" };
  if (res.status !== 200) throw new Error(`${name}@${version}: unexpected HTTP ${res.status}`);

  const doc = await res.json();
  const who = doc?._npmUser?.name ?? "unknown";
  const attestationUrl = doc?.dist?.attestations?.url;
  if (!attestationUrl) {
    return {
      state: "foreign",
      reason: `on the registry with NO provenance attestation (published by "${who}", not by ${PUBLISH_WORKFLOW_PATH})`
    };
  }

  const ares = await fetchWithRetry(fetchImpl, attestationUrl, accept, opts);
  if (ares.status !== 200) {
    throw new Error(`${name}@${version}: attestation fetch returned HTTP ${ares.status}`);
  }
  const bundle = await ares.json();
  for (const att of bundle?.attestations ?? []) {
    if (att?.predicateType !== SLSA_PREDICATE) continue;
    let statement;
    try {
      statement = JSON.parse(Buffer.from(att.bundle.dsseEnvelope.payload, "base64").toString());
    } catch {
      continue;
    }
    const wf = statement?.predicate?.buildDefinition?.externalParameters?.workflow;
    if (
      wf?.repository === `https://github.com/${repository}` &&
      wf?.path === PUBLISH_WORKFLOW_PATH
    ) {
      return { state: "pipeline", reason: `attested as built by ${repository} ${wf.path}` };
    }
    return {
      state: "foreign",
      reason: `provenance names ${wf?.repository ?? "?"} ${wf?.path ?? "?"}, expected ${repository} ${PUBLISH_WORKFLOW_PATH}`
    };
  }
  return { state: "foreign", reason: "attestation bundle has no SLSA provenance statement" };
}

/** GitHub Actions OIDC id-token for the npm registry audience (what pnpm requests). */
export async function getIdToken({ env, fetch: fetchImpl = fetch, registry = REGISTRY }) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error(
      "no GitHub OIDC token available (ACTIONS_ID_TOKEN_REQUEST_URL unset) — the job needs `permissions: id-token: write`"
    );
  }
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.append("audience", `npm:${new URL(registry).hostname}`);
  const res = await fetchImpl(url.href, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`
    }
  });
  if (res.status !== 200) throw new Error(`GitHub OIDC token request failed: HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body?.value !== "string") throw new Error("GitHub OIDC token response malformed");
  return body.value;
}

/**
 * The npm Trusted Publishing exchange, exactly as pnpm performs it before its PUT. A 2xx means a
 * Trusted Publisher matching this repo + workflow is attached to the package. The minted token is
 * short-lived and package-scoped; it is masked and dropped, never used or logged.
 *
 * @returns {Promise<{ok:true, token:string}|{ok:false, reason:string}>}
 */
export async function exchangeOidc({
  name,
  idToken,
  fetch: fetchImpl = fetch,
  registry = REGISTRY
}) {
  const res = await fetchImpl(
    `${registry}/-/npm/v1/oidc/token/exchange/package/${registryPath(name)}`,
    {
      method: "POST",
      body: "",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${idToken}`,
        "Content-Length": "0"
      }
    }
  );
  if (res.status >= 200 && res.status < 300) {
    const body = await res.json().catch(() => undefined);
    if (typeof body?.token === "string") return { ok: true, token: body.token };
    return { ok: false, reason: "exchange succeeded but returned no token" };
  }
  const hint =
    res.status === 404
      ? " — no Trusted Publisher is attached to this package (or the package name does not exist yet: a new package needs a manual first publish, then a Trusted Publisher on npmjs.com)"
      : "";
  return { ok: false, reason: `OIDC token exchange returned HTTP ${res.status}${hint}` };
}

/**
 * Check every package before anything is published.
 * @returns {Promise<{problems:string[], lines:string[]}>}
 */
export async function preflight({
  packages,
  repository,
  env,
  fetch: fetchImpl = fetch,
  sleep,
  mask = () => {}
}) {
  const problems = [];
  const lines = [];
  let idToken;
  for (const pkg of packages) {
    const tag = `${pkg.name}@${pkg.version}`;
    const cls = await classifyVersion({
      name: pkg.name,
      version: pkg.version,
      repository,
      fetch: fetchImpl,
      sleep
    });
    if (cls.state === "pipeline") {
      lines.push(`ok    ${tag}: already published by this pipeline — will skip`);
      continue;
    }
    if (cls.state === "foreign") {
      problems.push(
        `${tag}: ${cls.reason}. This pipeline never published it, so it cannot be skipped as "already released" — a version exists that this workflow has not proven it can publish. Bump the version (or, if the package is genuinely fine, attach a Trusted Publisher and release a new version).`
      );
      continue;
    }
    idToken ??= await getIdToken({ env, fetch: fetchImpl });
    const ex = await exchangeOidc({ name: pkg.name, idToken, fetch: fetchImpl });
    if (ex.ok) {
      mask(ex.token);
      lines.push(`ok    ${tag}: not yet published, OIDC exchange works — will publish`);
    } else {
      problems.push(`${tag}: ${ex.reason}`);
    }
  }
  return { problems, lines };
}

/**
 * The ordered publish loop. Stops at the first failure so a dependency is never skipped past.
 * @returns {Promise<{published:string[], skipped:string[], error?:string}>}
 */
export async function publishAll({
  packages,
  repository,
  fetch: fetchImpl = fetch,
  sleep,
  publish
}) {
  const published = [];
  const skipped = [];
  for (const pkg of packages) {
    const tag = `${pkg.name}@${pkg.version}`;
    const cls = await classifyVersion({
      name: pkg.name,
      version: pkg.version,
      repository,
      fetch: fetchImpl,
      sleep
    });
    if (cls.state === "pipeline") {
      skipped.push(tag);
      continue;
    }
    if (cls.state === "foreign") {
      return {
        published,
        skipped,
        error: `${tag}: ${cls.reason} — refusing to treat it as already released`
      };
    }
    const code = publish(pkg);
    if (code !== 0) return { published, skipped, error: `${tag}: publish exited ${code}` };
    published.push(tag);
  }
  return { published, skipped };
}

function pnpmPublish(pkg) {
  return spawnSync(
    "pnpm",
    ["--filter", pkg.name, "publish", "--access", "public", "--no-git-checks", "--provenance"],
    { stdio: "inherit" }
  ).status;
}

export async function main(
  cmd,
  { env = process.env, fetch: fetchImpl = fetch, publish = pnpmPublish, sleep } = {}
) {
  const packages = PUBLISH_ORDER.map((d) => readPackage(d));
  if (cmd === "list") {
    for (const p of packages) console.log(`${p.dir} ${p.name} ${shortName(p.name)}`);
    return 0;
  }
  const repository = env.GITHUB_REPOSITORY;
  if (!repository) {
    console.error("::error::GITHUB_REPOSITORY is not set");
    return 1;
  }
  if (cmd === "preflight") {
    const { problems, lines } = await preflight({
      packages,
      repository,
      env,
      fetch: fetchImpl,
      sleep,
      mask: (t) => console.log(`::add-mask::${t}`)
    });
    for (const l of lines) console.log(l);
    for (const p of problems) console.log(`::error title=Publish preflight::${p}`);
    if (problems.length > 0) {
      console.error(`\nPreflight FAILED for ${problems.length} package(s). Nothing was published.`);
      return 1;
    }
    console.log(`\nPreflight passed for ${packages.length} packages.`);
    return 0;
  }
  if (cmd === "publish") {
    const r = await publishAll({ packages, repository, fetch: fetchImpl, sleep, publish });
    for (const s of r.skipped)
      console.log(`::notice::${s} already published by this pipeline — skipping.`);
    if (r.error) {
      console.log(`::error title=Publish::${r.error}`);
      return 1;
    }
    console.log(`Published ${r.published.length}, skipped ${r.skipped.length}.`);
    return 0;
  }
  console.error("usage: publish-guard.mjs list|preflight|publish");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then(
    (code) => process.exit(code),
    (err) => {
      console.log(`::error title=Publish guard::${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  );
}
