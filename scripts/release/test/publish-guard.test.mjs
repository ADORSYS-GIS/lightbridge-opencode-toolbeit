import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PUBLISH_ORDER,
  PUBLISH_WORKFLOW_PATH,
  REPO_ROOT,
  classifyVersion,
  exchangeOidc,
  getIdToken,
  main,
  preflight,
  publishAll,
  readPackage,
  shortName
} from "../publish-guard.mjs";

const REPO = "ADORSYS-GIS/lightbridge-opencode-toolbeit";
const noSleep = async () => {};

const json = (status, body) => ({ status, json: async () => body });

function bundleFor(workflow) {
  const statement = {
    predicate: { buildDefinition: { externalParameters: { workflow } } }
  };
  return {
    attestations: [
      {
        predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
        bundle: {}
      },
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") }
        }
      }
    ]
  };
}

const goodWorkflow = {
  repository: `https://github.com/${REPO}`,
  path: PUBLISH_WORKFLOW_PATH,
  ref: "refs/heads/main"
};

/**
 * Fake registry. `versions` maps "name@version" → "absent" | "pipeline" | "manual" | workflow obj.
 * `exchange` maps name → HTTP status (default 200).
 */
function fakeRegistry({ versions = {}, exchange = {}, down = false } = {}) {
  const calls = [];
  const fetch = vi.fn(async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (down) return json(503, {});
    const ex = url.match(/oidc\/token\/exchange\/package\/(.+)$/);
    if (ex) {
      const name = decodeURIComponent(ex[1]);
      const status = exchange[name] ?? 200;
      return status === 200 ? json(200, { token: `tok-${name}` }) : json(status, {});
    }
    const att = url.match(/attestations\/(.+)$/);
    if (att) return json(200, bundleFor(versions[`att:${decodeURIComponent(att[1])}`]));
    const m = url.match(/registry\.npmjs\.org\/(.+?)\/(\d[^/]*)$/);
    if (!m) return json(404, {});
    const key = `${decodeURIComponent(m[1])}@${m[2]}`;
    const kind = versions[key] ?? "absent";
    if (kind === "absent") return json(404, {});
    if (kind === "manual") return json(200, { _npmUser: { name: "a-human" }, dist: {} });
    const wf = kind === "pipeline" ? goodWorkflow : kind;
    versions[`att:${key}`] = wf;
    return json(200, {
      _npmUser: { name: "GitHub Actions" },
      dist: {
        attestations: {
          url: `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(key)}`
        }
      }
    });
  });
  return { fetch, calls };
}

const pkg = { dir: "d", name: "@vymalo/opencode-x", version: "1.0.0" };
const classify = (reg, p = pkg) =>
  classifyVersion({
    name: p.name,
    version: p.version,
    repository: REPO,
    fetch: reg.fetch,
    sleep: noSleep
  });

describe("classifyVersion", () => {
  it("absent when the registry 404s", async () => {
    const r = await classify(fakeRegistry());
    expect(r.state).toBe("absent");
  });

  it("pipeline when the version carries this repo's publish.yml provenance", async () => {
    const r = await classify(
      fakeRegistry({ versions: { "@vymalo/opencode-x@1.0.0": "pipeline" } })
    );
    expect(r.state).toBe("pipeline");
  });

  it("foreign (the concealed failure) when the version has no attestation — a hand publish", async () => {
    const r = await classify(fakeRegistry({ versions: { "@vymalo/opencode-x@1.0.0": "manual" } }));
    expect(r.state).toBe("foreign");
    expect(r.reason).toMatch(/NO provenance attestation/);
    expect(r.reason).toMatch(/a-human/);
  });

  it("foreign when the provenance comes from another repository", async () => {
    const r = await classify(
      fakeRegistry({
        versions: {
          "@vymalo/opencode-x@1.0.0": {
            ...goodWorkflow,
            repository: "https://github.com/evil/fork"
          }
        }
      })
    );
    expect(r.state).toBe("foreign");
  });

  it("foreign when the provenance comes from a different workflow file", async () => {
    const r = await classify(
      fakeRegistry({
        versions: {
          "@vymalo/opencode-x@1.0.0": { ...goodWorkflow, path: ".github/workflows/other.yml" }
        }
      })
    );
    expect(r.state).toBe("foreign");
  });

  it("fails closed (throws) on a registry outage instead of guessing absent/pipeline", async () => {
    await expect(classify(fakeRegistry({ down: true }))).rejects.toThrow(/503/);
  });

  it("throws on an unexpected status such as 403", async () => {
    const reg = { fetch: async () => json(403, {}) };
    await expect(classify(reg)).rejects.toThrow(/unexpected HTTP 403/);
  });

  it("throws when the attestation bundle cannot be fetched", async () => {
    const reg = {
      fetch: async (url) =>
        url.includes("attestations")
          ? json(403, {})
          : json(200, {
              dist: { attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/x" } }
            })
    };
    await expect(classify(reg)).rejects.toThrow(/attestation fetch/);
  });

  it("foreign when the bundle has no SLSA statement", async () => {
    const reg = {
      fetch: async (url) =>
        url.includes("attestations")
          ? json(200, { attestations: [{ predicateType: "other" }] })
          : json(200, {
              dist: { attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/x" } }
            })
    };
    expect((await classify(reg)).state).toBe("foreign");
  });

  it("retries transient 5xx before giving up", async () => {
    let n = 0;
    const reg = { fetch: async () => (++n < 3 ? json(502, {}) : json(404, {})) };
    expect((await classify(reg)).state).toBe("absent");
    expect(n).toBe(3);
  });
});

describe("exchangeOidc / getIdToken", () => {
  it("ok on 200 with a token", async () => {
    const r = await exchangeOidc({ name: pkg.name, idToken: "id", fetch: fakeRegistry().fetch });
    expect(r).toEqual({ ok: true, token: "tok-@vymalo/opencode-x" });
  });

  it("404 explains the bootstrap requirement", async () => {
    const r = await exchangeOidc({
      name: pkg.name,
      idToken: "id",
      fetch: fakeRegistry({ exchange: { [pkg.name]: 404 } }).fetch
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Trusted Publisher/);
    expect(r.reason).toMatch(/manual first publish/);
  });

  it("not ok on a 2xx without a token", async () => {
    const r = await exchangeOidc({
      name: pkg.name,
      idToken: "id",
      fetch: async () => json(200, {})
    });
    expect(r.ok).toBe(false);
  });

  it("not ok on a non-404 error, without the bootstrap hint", async () => {
    const r = await exchangeOidc({
      name: pkg.name,
      idToken: "id",
      fetch: async () => json(401, {})
    });
    expect(r).toEqual({ ok: false, reason: "OIDC token exchange returned HTTP 401" });
  });

  it("getIdToken requests the npm audience", async () => {
    const fetch = vi.fn(async () => json(200, { value: "jwt" }));
    const t = await getIdToken({
      env: {
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://gh/token?x=1",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "r"
      },
      fetch
    });
    expect(t).toBe("jwt");
    expect(fetch.mock.calls[0][0]).toContain("audience=npm%3Aregistry.npmjs.org");
  });

  it("getIdToken explains a missing id-token permission", async () => {
    await expect(getIdToken({ env: {}, fetch: vi.fn() })).rejects.toThrow(/id-token: write/);
  });

  it("getIdToken rejects a failed or malformed response", async () => {
    const env = {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://gh/t",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "r"
    };
    await expect(getIdToken({ env, fetch: async () => json(500, {}) })).rejects.toThrow(/HTTP 500/);
    await expect(getIdToken({ env, fetch: async () => json(200, {}) })).rejects.toThrow(
      /malformed/
    );
  });
});

const two = [
  { dir: "a", name: "@vymalo/opencode-a", version: "1.0.0" },
  { dir: "b", name: "@vymalo/opencode-b", version: "1.0.0" }
];
const env = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://gh/t", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "r" };
function withGithub(reg) {
  const inner = reg.fetch;
  reg.fetch = vi.fn(async (url, init) =>
    url.startsWith("https://gh/") ? json(200, { value: "jwt" }) : inner(url, init)
  );
  return reg;
}

describe("preflight", () => {
  it("passes when every package is publishable or already pipeline-published", async () => {
    const reg = withGithub(fakeRegistry({ versions: { "@vymalo/opencode-a@1.0.0": "pipeline" } }));
    const masked = [];
    const r = await preflight({
      packages: two,
      repository: REPO,
      env,
      fetch: reg.fetch,
      sleep: noSleep,
      mask: (t) => masked.push(t)
    });
    expect(r.problems).toEqual([]);
    expect(r.lines[0]).toMatch(/will skip/);
    expect(r.lines[1]).toMatch(/will publish/);
    expect(masked).toEqual(["tok-@vymalo/opencode-b"]);
  });

  it("the provider-sync scenario: missing Trusted Publisher fails BEFORE anything is published", async () => {
    const reg = withGithub(fakeRegistry({ exchange: { "@vymalo/opencode-b": 404 } }));
    const r = await preflight({
      packages: two,
      repository: REPO,
      env,
      fetch: reg.fetch,
      sleep: noSleep
    });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/opencode-b@1\.0\.0.*Trusted Publisher/);
    expect(reg.fetch.mock.calls.some(([, i]) => i?.method === "PUT")).toBe(false);
  });

  it("the concealed-failure scenario: a hand-published version fails instead of skipping", async () => {
    const reg = withGithub(fakeRegistry({ versions: { "@vymalo/opencode-a@1.0.0": "manual" } }));
    const r = await preflight({
      packages: two,
      repository: REPO,
      env,
      fetch: reg.fetch,
      sleep: noSleep
    });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/opencode-a@1\.0\.0.*NO provenance attestation/);
  });

  it("reports every problem, not just the first", async () => {
    const reg = withGithub(
      fakeRegistry({
        versions: { "@vymalo/opencode-a@1.0.0": "manual" },
        exchange: { "@vymalo/opencode-b": 404 }
      })
    );
    const r = await preflight({
      packages: two,
      repository: REPO,
      env,
      fetch: reg.fetch,
      sleep: noSleep
    });
    expect(r.problems).toHaveLength(2);
  });
});

describe("publishAll", () => {
  it("publishes absent packages in order and skips pipeline-published ones", async () => {
    const reg = fakeRegistry({ versions: { "@vymalo/opencode-a@1.0.0": "pipeline" } });
    const publish = vi.fn(() => 0);
    const r = await publishAll({
      packages: two,
      repository: REPO,
      fetch: reg.fetch,
      sleep: noSleep,
      publish
    });
    expect(r.error).toBeUndefined();
    expect(r.skipped).toEqual(["@vymalo/opencode-a@1.0.0"]);
    expect(r.published).toEqual(["@vymalo/opencode-b@1.0.0"]);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("legitimate re-run: everything already pipeline-published is a clean no-op", async () => {
    const reg = fakeRegistry({
      versions: { "@vymalo/opencode-a@1.0.0": "pipeline", "@vymalo/opencode-b@1.0.0": "pipeline" }
    });
    const publish = vi.fn(() => 0);
    const r = await publishAll({
      packages: two,
      repository: REPO,
      fetch: reg.fetch,
      sleep: noSleep,
      publish
    });
    expect(r.error).toBeUndefined();
    expect(r.skipped).toHaveLength(2);
    expect(publish).not.toHaveBeenCalled();
  });

  it("fails on a foreign version and publishes nothing after it", async () => {
    const reg = fakeRegistry({ versions: { "@vymalo/opencode-a@1.0.0": "manual" } });
    const publish = vi.fn(() => 0);
    const r = await publishAll({
      packages: two,
      repository: REPO,
      fetch: reg.fetch,
      sleep: noSleep,
      publish
    });
    expect(r.error).toMatch(/refusing to treat it as already released/);
    expect(publish).not.toHaveBeenCalled();
  });

  it("stops at the first publish failure", async () => {
    const reg = fakeRegistry();
    const publish = vi.fn(() => 1);
    const r = await publishAll({
      packages: two,
      repository: REPO,
      fetch: reg.fetch,
      sleep: noSleep,
      publish
    });
    expect(r.error).toMatch(/publish exited 1/);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe("PUBLISH_ORDER vs the workspace (drift guard)", () => {
  const pkgsDir = join(REPO_ROOT, "packages");
  const all = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));

  const manifests = readdirSync(pkgsDir).map((d) => ({
    dir: d,
    json: JSON.parse(readFileSync(join(pkgsDir, d, "package.json"), "utf8"))
  }));

  it("lists exactly the non-private workspace packages, once each", () => {
    const published = manifests
      .filter((m) => !m.json.private)
      .map((m) => m.dir)
      .sort();
    expect([...PUBLISH_ORDER].sort()).toEqual(published);
    expect(new Set(PUBLISH_ORDER).size).toBe(PUBLISH_ORDER.length);
    expect(all.private).toBe(true);
  });

  it("publishes every workspace dependency before its dependents", () => {
    const byName = new Map(manifests.map((m) => [m.json.name, m.dir]));
    PUBLISH_ORDER.forEach((dir, idx) => {
      const m = manifests.find((x) => x.dir === dir);
      const deps = {
        ...m.json.dependencies,
        ...m.json.optionalDependencies,
        ...m.json.peerDependencies
      };
      for (const dep of Object.keys(deps)) {
        const depDir = byName.get(dep);
        if (depDir && PUBLISH_ORDER.includes(depDir)) {
          expect(PUBLISH_ORDER.indexOf(depDir), `${dir} depends on ${depDir}`).toBeLessThan(idx);
        }
      }
    });
  });

  it("readPackage/shortName agree with the manifests", () => {
    const p = readPackage("opencode-auth-core");
    expect(p.name).toBe("@vymalo/opencode-auth-core");
    expect(shortName(p.name)).toBe("auth-core");
  });
});

describe("main (CLI wiring)", () => {
  const ghEnv = { GITHUB_REPOSITORY: REPO, ...env };
  const quiet = () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  };

  it("list prints every package in publish order", async () => {
    const out = [];
    vi.spyOn(console, "log").mockImplementation((l) => out.push(l));
    expect(await main("list")).toBe(0);
    expect(out.map((l) => l.split(" ")[0])).toEqual(PUBLISH_ORDER);
  });

  it("requires GITHUB_REPOSITORY", async () => {
    quiet();
    expect(await main("preflight", { env: {} })).toBe(1);
  });

  it("rejects an unknown command", async () => {
    quiet();
    expect(await main("nope", { env: ghEnv })).toBe(2);
  });

  it("preflight passes on a clean slate and fails (exit 1, nothing published) on a missing Trusted Publisher", async () => {
    quiet();
    const ok = withGithub(fakeRegistry());
    expect(await main("preflight", { env: ghEnv, fetch: ok.fetch, sleep: noSleep })).toBe(0);
    const bad = withGithub(fakeRegistry({ exchange: { "@vymalo/opencode-provider-sync": 404 } }));
    expect(await main("preflight", { env: ghEnv, fetch: bad.fetch, sleep: noSleep })).toBe(1);
  });

  it("publish exits 1 on a foreign version without invoking the publisher", async () => {
    quiet();
    const reg = fakeRegistry({
      versions: {
        [`@vymalo/opencode-auth-core@${readPackage("opencode-auth-core").version}`]: "manual"
      }
    });
    const publish = vi.fn(() => 0);
    expect(await main("publish", { env: ghEnv, fetch: reg.fetch, sleep: noSleep, publish })).toBe(
      1
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("publish exits 0 when every package publishes", async () => {
    quiet();
    const publish = vi.fn(() => 0);
    expect(
      await main("publish", { env: ghEnv, fetch: fakeRegistry().fetch, sleep: noSleep, publish })
    ).toBe(0);
    expect(publish).toHaveBeenCalledTimes(PUBLISH_ORDER.length);
  });
});
