import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  normalizeRemote,
  parseGitConfig,
  parseOriginRemote,
  resolveOriginRemote,
  resolveRepoRoot
} from "../src/git.js";

describe("normalizeRemote", () => {
  it("normalizes scp-style remotes, stripping the user and trailing .git", () => {
    expect(normalizeRemote("git@github.com:acme/webapp.git")).toBe("github.com/acme/webapp");
  });

  it("normalizes https remotes, stripping userinfo, query and fragment", () => {
    expect(normalizeRemote("https://user:pass@github.com/acme/webapp.git")).toBe(
      "github.com/acme/webapp"
    );
    expect(normalizeRemote("https://github.com/acme/webapp.git?ref=main#x")).toBe(
      "github.com/acme/webapp"
    );
  });

  it("passes through bare gitlab-style host:path without a user", () => {
    expect(normalizeRemote("gitlab.example.com:org/repo.git")).toBe("gitlab.example.com/org/repo");
  });

  it("strips trailing slashes", () => {
    expect(normalizeRemote("https://github.com/acme/webapp.git/")).toBe("github.com/acme/webapp");
  });

  it("returns undefined for local paths and garbage", () => {
    expect(normalizeRemote("/opt/repo.git")).toBeUndefined();
    expect(normalizeRemote("")).toBeUndefined();
    expect(normalizeRemote("   ")).toBeUndefined();
  });
});

describe("parseGitConfig", () => {
  it("extracts the origin remote url", () => {
    const text = [
      "[core]",
      "\trepositoryformatversion = 1",
      "",
      '[remote "origin"]',
      "\turl = git@github.com:acme/webapp.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      "",
      '[branch "main"]',
      "\tremote = origin"
    ].join("\n");
    expect(parseOriginRemote(text)).toBe("git@github.com:acme/webapp.git");
  });

  it("handles quotes around the url value", () => {
    const text = '[remote "origin"]\n\turl = "https://github.com/acme/webapp.git"\n';
    expect(parseOriginRemote(text)).toBe("https://github.com/acme/webapp.git");
  });

  it("ignores comments and returns nothing for other remotes", () => {
    const text = [
      "# comment",
      '[remote "upstream"]',
      "\turl = https://github.com/acme/upstream.git"
    ].join("\n");
    expect(parseOriginRemote(text)).toBeUndefined();
    expect(parseGitConfig(text).get("remote.upstream")?.get("url")).toBe(
      "https://github.com/acme/upstream.git"
    );
  });
});

describe("resolveRepoRoot + resolveOriginRemote (off disk)", () => {
  const tempDirs: string[] = [];

  async function makeRepo(root: string): Promise<void> {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(
      join(root, ".git", "config"),
      '[remote "origin"]\n\turl = git@github.com:acme/webapp.git\n'
    );
  }

  afterEach(async () => {
    // Best-effort cleanup; failure is not a test failure.
    for (const dir of tempDirs) {
      await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }));
    }
  });

  it("walks up from a subdirectory to the repo root and resolves origin", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-auth-git-"));
    tempDirs.push(base);
    await makeRepo(base);
    await mkdir(join(base, "src", "app"), { recursive: true });

    const root = await resolveRepoRoot(join(base, "src", "app"));
    expect(root).toBe(base);
    expect(await resolveOriginRemote(base)).toBe("github.com/acme/webapp");
  });

  it("returns undefined when no enclosing repository exists", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-auth-no-git-"));
    tempDirs.push(base);
    expect(await resolveRepoRoot(base)).toBeUndefined();
    expect(await resolveOriginRemote(base)).toBeUndefined();
  });

  it("resolves a linked-worktree .git file via commondir", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-auth-common-"));
    tempDirs.push(base);
    const common = join(base, ".git");
    await mkdir(join(common, "worktrees", "feature"), { recursive: true });
    await writeFile(
      join(common, "config"),
      '[remote "origin"]\n\turl = git@github.com:acme/webapp.git\n'
    );

    // The worktree checkout has a `.git` FILE pointing at the worktree gitdir
    // (under the common dir), which carries a `commondir` marker back to the
    // shared config (`../..` from `.git/worktrees/feature` → `.git`).
    const worktree = join(base, "worktrees", "feature");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(common, "worktrees", "feature", "commondir"), "../..");
    await writeFile(join(common, "worktrees", "feature", "HEAD"), "ref: refs/heads/feature\n");
    await writeFile(join(worktree, ".git"), "gitdir: ../../.git/worktrees/feature\n");

    expect(await resolveOriginRemote(worktree)).toBe("github.com/acme/webapp");
  });

  it("ignores a .git pointer to a non-directory or to a dir without HEAD", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-auth-badpointer-"));
    tempDirs.push(base);
    const worktree = join(base, "wt");
    await mkdir(worktree, { recursive: true });

    // gitdir pointing at a regular file — not a directory.
    const notADir = join(base, "not-a-dir");
    await writeFile(notADir, "junk");
    await writeFile(join(worktree, ".git"), `gitdir: ${notADir}\n`);
    expect(await resolveOriginRemote(worktree)).toBeUndefined();

    // gitdir pointing at a directory that is not a git dir (no HEAD marker).
    const notGit = join(base, "plain-dir");
    await mkdir(notGit, { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${notGit}\n`);
    expect(await resolveOriginRemote(worktree)).toBeUndefined();
  });

  it("rejects a symlinked or non-regular config instead of following it", async () => {
    const base = await mkdtemp(join(tmpdir(), "repo-auth-symconfig-"));
    tempDirs.push(base);
    const root = join(base, "repo");
    await mkdir(join(root, ".git"), { recursive: true });
    const victim = join(base, "victim");
    await writeFile(victim, "secret file content");
    await symlink(victim, join(root, ".git", "config"));

    expect(await resolveOriginRemote(root)).toBeUndefined();
  });
});
