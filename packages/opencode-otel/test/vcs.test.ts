import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  describeRemote,
  type FileReader,
  parseRemoteFromConfig,
  readVcsInfo,
  sanitizeRemoteUrl
} from "../src/vcs.js";

/** A reader over an in-memory filesystem, keyed by absolute path. */
function reader(files: Record<string, string>): FileReader {
  return async (path) => {
    if (!(path in files)) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    }
    return files[path];
  };
}

const SHA = "9d59409acf479dfa0df1aa568182e43e43df8bbe";

describe("sanitizeRemoteUrl", () => {
  it("strips credentials from an https remote", () => {
    expect(sanitizeRemoteUrl("https://user:ghp_secrettoken@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo"
    );
  });

  it("drops even a bare username, which never identifies the repository", () => {
    expect(sanitizeRemoteUrl("https://someuser@gitlab.com/org/repo.git")).toBe(
      "https://gitlab.com/org/repo"
    );
  });

  it("rewrites scp-like ssh syntax to an ssh URL rather than inventing https", () => {
    expect(sanitizeRemoteUrl("git@github.com:ADORSYS-GIS/repo.git")).toBe(
      "ssh://github.com/ADORSYS-GIS/repo"
    );
  });

  it("keeps an explicit ssh:// remote as ssh", () => {
    expect(sanitizeRemoteUrl("ssh://git@github.com:22/org/repo.git")).toBe(
      "ssh://github.com:22/org/repo"
    );
  });

  it("drops query and fragment, which can carry tokens too", () => {
    expect(sanitizeRemoteUrl("https://github.com/org/repo.git?token=abc#frag")).toBe(
      "https://github.com/org/repo"
    );
  });

  it("reports nothing for a local path or unparseable value", () => {
    expect(sanitizeRemoteUrl("/srv/git/repo.git")).toBeUndefined();
    expect(sanitizeRemoteUrl("   ")).toBeUndefined();
  });
});

describe("describeRemote", () => {
  it("splits owner, name and provider", () => {
    expect(describeRemote("https://github.com/ADORSYS-GIS/lightbridge")).toEqual({
      owner: "ADORSYS-GIS",
      name: "lightbridge",
      provider: "github"
    });
  });

  it("recognises self-hosted gitlab and gitea by host", () => {
    expect(describeRemote("https://gitlab.com/g/p").provider).toBe("gitlab");
    expect(describeRemote("https://gitea.example.com/g/p").provider).toBe("gitea");
  });

  it("omits the provider for an unrecognised host, rather than guessing", () => {
    expect(describeRemote("https://git.internal.example/g/p")).toEqual({
      owner: "g",
      name: "p"
    });
  });

  it("handles a nested gitlab group path by taking the last two segments", () => {
    expect(describeRemote("https://gitlab.com/group/sub/proj")).toMatchObject({
      owner: "sub",
      name: "proj"
    });
  });
});

describe("parseRemoteFromConfig", () => {
  const config = `[core]
\trepositoryformatversion = 0
[remote "upstream"]
\turl = https://github.com/upstream/repo.git
[remote "origin"]
\turl = git@github.com:mine/repo.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
`;

  it("prefers origin over any other remote", () => {
    expect(parseRemoteFromConfig(config)).toBe("git@github.com:mine/repo.git");
  });

  it("falls back to the first remote when there is no origin", () => {
    expect(parseRemoteFromConfig('[remote "upstream"]\n\turl = https://x/y.git\n')).toBe(
      "https://x/y.git"
    );
  });

  it("returns nothing when no remote is configured", () => {
    expect(parseRemoteFromConfig("[core]\n\tbare = false\n")).toBeUndefined();
  });

  it("does not mistake a url outside a remote section for a remote", () => {
    expect(parseRemoteFromConfig('[branch "main"]\n\turl = not-a-remote\n')).toBeUndefined();
  });
});

describe("readVcsInfo", () => {
  it("reads a plain clone", async () => {
    const info = await readVcsInfo(
      "/repo",
      reader({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.git/config": '[remote "origin"]\n\turl = https://github.com/org/proj.git\n',
        "/repo/.git/refs/heads/main": `${SHA}\n`
      })
    );

    expect(info).toEqual({
      url: "https://github.com/org/proj",
      name: "proj",
      owner: "org",
      provider: "github",
      ref: "main",
      refType: "branch",
      revision: SHA
    });
  });

  it("follows a .git file to a linked worktree's git dir and common dir", async () => {
    // The shape this repository's own development uses: `.git` is a file, HEAD
    // lives in the worktree's git dir, config lives in the shared common dir.
    const info = await readVcsInfo(
      "/wt",
      reader({
        "/wt/.git": "gitdir: /main/.git/worktrees/feature\n",
        "/main/.git/worktrees/feature/HEAD": "ref: refs/heads/feature\n",
        "/main/.git/worktrees/feature/commondir": "../..\n",
        "/main/.git/config": '[remote "origin"]\n\turl = git@github.com:org/proj.git\n',
        "/main/.git/refs/heads/feature": `${SHA}\n`
      })
    );

    expect(info).toMatchObject({
      url: "ssh://github.com/org/proj",
      ref: "feature",
      revision: SHA
    });
  });

  it("falls back to packed-refs when the loose ref is absent", async () => {
    const info = await readVcsInfo(
      "/repo",
      reader({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/.git/packed-refs": `# pack-refs with: peeled\n${SHA} refs/heads/main\n`
      })
    );
    expect(info.revision).toBe(SHA);
  });

  it("reports a revision but no ref on a detached HEAD", async () => {
    const info = await readVcsInfo("/repo", reader({ "/repo/.git/HEAD": `${SHA}\n` }));
    expect(info.revision).toBe(SHA);
    expect(info.ref).toBeUndefined();
  });

  it("labels a checked-out tag as a tag", async () => {
    const info = await readVcsInfo(
      "/repo",
      reader({
        "/repo/.git/HEAD": "ref: refs/tags/v1.2.3\n",
        "/repo/.git/refs/tags/v1.2.3": `${SHA}\n`
      })
    );
    expect(info).toMatchObject({ ref: "v1.2.3", refType: "tag" });
  });

  it("still reports the branch when the repository has no remote", async () => {
    const info = await readVcsInfo(
      "/repo",
      reader({ "/repo/.git/HEAD": "ref: refs/heads/main\n", "/repo/.git/config": "[core]\n" })
    );
    expect(info).toEqual({ ref: "main", refType: "branch" });
  });

  it("returns nothing outside a repository, or with no path at all", async () => {
    expect(await readVcsInfo("/nowhere", reader({}))).toEqual({});
    expect(await readVcsInfo(undefined, reader({}))).toEqual({});
  });
});

describe("readVcsInfo against a real repository on disk", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it("reads a real .git directory through the default fs reader", async () => {
    dir = await mkdtemp(join(tmpdir(), "otel-vcs-"));
    await mkdir(join(dir, ".git", "refs", "heads"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/trunk\n");
    await writeFile(
      join(dir, ".git", "config"),
      '[remote "origin"]\n\turl = https://token:secret@example.com/o/r.git\n'
    );
    await writeFile(join(dir, ".git", "refs", "heads", "trunk"), `${SHA}\n`);

    const info = await readVcsInfo(dir);
    expect(info.ref).toBe("trunk");
    expect(info.revision).toBe(SHA);
    // The credential must not survive the round trip.
    expect(info.url).toBe("https://example.com/o/r");
    expect(JSON.stringify(info)).not.toContain("secret");
  });
});
