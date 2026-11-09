import { describe, expect, it, vi } from "vitest";
import { apply, main, npmMeetsFloor, plan, validateInputs } from "../dist-tag.mjs";
import { PUBLISH_ORDER, readPackage } from "../publish-guard.mjs";

const json = (status, body) => ({ status, json: async () => body });
const packages = PUBLISH_ORDER.map((d) => readPackage(d));
const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://gh/token",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
  GITHUB_REPOSITORY: "o/r"
};

/** tags: name -> tags object; `missing` => version 404; `noPublisher` => OIDC exchange 404. */
function fakeFetch({ tags = {}, missing = [], noPublisher = [] } = {}) {
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.startsWith("https://gh/token")) return json(200, { value: "idtok" });
    if (u.includes("/oidc/token/exchange/package/")) {
      const name = decodeURIComponent(u.split("/package/")[1]);
      return noPublisher.includes(name) ? json(404, {}) : json(200, { token: "minted" });
    }
    if (u.includes("/-/package/")) {
      const name = decodeURIComponent(u.split("/-/package/")[1].replace("/dist-tags", ""));
      return json(200, tags[name] ?? { latest: "0.18.0" });
    }
    const name = decodeURIComponent(
      u.replace("https://registry.npmjs.org/", "").replace(/\/[^/]+$/, "")
    );
    return missing.includes(name) ? json(404, {}) : json(200, {});
  });
}

describe("validateInputs", () => {
  it.each(["v1", "V1", "1", "1.x", "^1", "x", "=1", "latest", "", "a b"])(
    "rejects tag %j",
    (tag) => {
      expect(validateInputs({ tag, version: "0.17.0" })).toBeTruthy();
    }
  );
  it("accepts a name that is not a range", () => {
    expect(validateInputs({ tag: "opencode-v1", version: "0.17.0" })).toBeUndefined();
  });
  it.each(["", "0.17", "v0.17.0", "^0.17.0", "latest"])("rejects version %j", (version) => {
    expect(validateInputs({ tag: "opencode-v1", version })).toBeTruthy();
  });
});

describe("npmMeetsFloor", () => {
  it.each([
    ["11.11.0", false],
    ["11.20.9", false],
    ["11.21.0", true],
    ["11.21.2", true],
    ["12.1.9", false],
    ["12.2.0", true],
    ["13.0.0", true],
    ["10.9.0", false]
  ])("%s -> %s", (v, ok) => expect(npmMeetsFloor(v)).toBe(ok));
});

describe("plan", () => {
  it("plans all thirteen and records latest", async () => {
    const r = await plan({
      packages,
      tag: "opencode-v1",
      version: "0.17.0",
      env,
      fetch: fakeFetch()
    });
    expect(r.problems).toEqual([]);
    expect(r.todo).toHaveLength(13);
    expect(r.todo[0].latestBefore).toBe("0.18.0");
  });
  it("skips packages already tagged (idempotent)", async () => {
    const tags = Object.fromEntries(
      packages.map((p) => [p.name, { latest: "0.18.0", "opencode-v1": "0.17.0" }])
    );
    const r = await plan({
      packages,
      tag: "opencode-v1",
      version: "0.17.0",
      env,
      fetch: fakeFetch({ tags })
    });
    expect(r.todo).toEqual([]);
    expect(r.problems).toEqual([]);
  });
  it("reports every problem, not just the first", async () => {
    const f = fakeFetch({
      missing: [packages[0].name],
      noPublisher: [packages[1].name, packages[2].name]
    });
    const r = await plan({ packages, tag: "opencode-v1", version: "0.17.0", env, fetch: f });
    expect(r.problems).toHaveLength(3);
    expect(r.problems.join("\n")).toContain("dist-tag.yml");
  });
});

describe("apply", () => {
  const todo = packages.slice(0, 3).map((p) => ({ ...p, latestBefore: "0.18.0" }));
  it("collects all failures and keeps going", async () => {
    const run = vi.fn((pkg) => (pkg.name === todo[0].name ? 1 : 0));
    const r = await apply({ todo, tag: "t", version: "0.17.0", fetch: fakeFetch(), run });
    expect(run).toHaveBeenCalledTimes(3);
    expect(r.failed).toEqual([todo[0].name]);
    expect(r.problems[0]).toContain("Allow npm dist-tag");
  });
  it("fails if latest moved", async () => {
    const tags = { [todo[1].name]: { latest: "0.17.0" } };
    const r = await apply({
      todo,
      tag: "t",
      version: "0.17.0",
      fetch: fakeFetch({ tags }),
      run: () => 0
    });
    expect(r.problems.join()).toContain("MOVED");
  });
});

describe("main", () => {
  const e = (o = {}) => ({ ...env, DIST_TAG: "opencode-v1", DIST_TAG_VERSION: "0.17.0", ...o });
  const ok = () => "11.21.2";
  const quiet = () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  };
  it("rejects v1 before touching the network", async () => {
    quiet();
    const f = fakeFetch();
    expect(await main("plan", { env: e({ DIST_TAG: "v1" }), fetch: f, getNpmVersion: ok })).toBe(1);
    expect(f).not.toHaveBeenCalled();
  });
  it("fails on an npm below the floor", async () => {
    quiet();
    const g = () => "11.11.0";
    expect(await main("plan", { env: e(), fetch: fakeFetch(), getNpmVersion: g })).toBe(1);
  });
  it("plan writes nothing", async () => {
    quiet();
    const run = vi.fn(() => 0);
    expect(await main("plan", { env: e(), fetch: fakeFetch(), getNpmVersion: ok, run })).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
  it("apply tags all thirteen", async () => {
    quiet();
    const run = vi.fn(() => 0);
    expect(await main("apply", { env: e(), fetch: fakeFetch(), getNpmVersion: ok, run })).toBe(0);
    expect(run).toHaveBeenCalledTimes(13);
  });
  it("a failed plan blocks apply entirely", async () => {
    quiet();
    const run = vi.fn(() => 0);
    const f = fakeFetch({ noPublisher: [packages[5].name] });
    expect(await main("apply", { env: e(), fetch: f, getNpmVersion: ok, run })).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });
  it("usage error on unknown command", async () => {
    quiet();
    expect(await main("nope", { env: e(), getNpmVersion: ok })).toBe(2);
  });
});
