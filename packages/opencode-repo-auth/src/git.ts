import { lstat, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Git config files are small; anything beyond this is not a genuine repo. */
const GIT_CONFIG_MAX_BYTES = 256 * 1024;
/** Bound the read so a FIFO / stalled file cannot hang the config hook. */
const GIT_CONFIG_READ_TIMEOUT_MS = 2_000;

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return entry.isFile();
  } catch {
    return false;
  }
}

/**
 * Git identity resolution, read directly off disk (`.git/config`, worktree
 * aware) rather than shelling out to `git` — no subprocess, no `git` on
 * `PATH`. Mirrors the house precedent in otel's VCS collector. The remote is
 * log-only in v1: nothing is ever derived from it, so the accepted trade-off
 * (raw config misses `url.<base>.insteadOf` rewrites that `git remote get-url`
 * would apply) is harmless; revisit if resolve-by-remote ever lands.
 */

/**
 * Walk up from `startDir` to the nearest ancestor that contains a `.git` entry.
 * `.git` may be a directory (a normal checkout) or a file (a linked worktree,
 * pointing at the common dir). Returns the repo root, or `undefined` when no
 * enclosing repository exists.
 */
export async function resolveRepoRoot(startDir: string): Promise<string | undefined> {
  let current = resolve(startDir);
  for (;;) {
    const gitEntry = join(current, ".git");
    try {
      const entry = await stat(gitEntry);
      if (entry.isDirectory() || entry.isFile()) {
        return current;
      }
    } catch {
      // No .git here — keep walking up.
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Resolve the git "common dir" (where `config` lives) for a repo root, handling
 * the linked-worktree `.git`-file case:
 *   - `.git` is a directory  → common dir is `.git` itself.
 *   - `.git` is a file        → read `gitdir: <path>`; the pointed-at worktree
 *     gitdir may carry a `commondir` file (relative to itself) that names the
 *     shared object/config dir. Falls back to the worktree gitdir when no
 *     `commondir` marker exists (a bare gitdir without worktree layout).
 * Returns the directory containing the `config` file, or `undefined`.
 *
 * The `gitdir:` pointer is attacker-influenced (the `.git` file is part of the
 * tree the user opened), so it is validated defensively: the target must be a
 * real directory (no symlinks), must contain a `HEAD` file (git's own marker
 * that a worktree gitdir exists there), and its `config` must be a regular
 * file — a FIFO/socket/device/symlink is rejected so a crafted tree cannot
 * hang the config hook on a blocking read or reach into unrelated files.
 */
export async function resolveGitCommonDir(repoRoot: string): Promise<string | undefined> {
  const gitEntry = join(repoRoot, ".git");
  let commonDir: string;
  try {
    const entry = await stat(gitEntry);
    if (entry.isDirectory()) {
      commonDir = gitEntry;
    } else if (entry.isFile()) {
      const pointer = await readFile(gitEntry, "utf8");
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (!match) {
        return undefined;
      }
      const gitDir = isAbsolute(match[1].trim())
        ? match[1].trim()
        : join(dirname(gitEntry), match[1].trim());
      try {
        const dirEntry = await lstat(gitDir);
        if (!dirEntry.isDirectory()) {
          return undefined;
        }
      } catch {
        return undefined;
      }
      // git writes a HEAD at the top of every (worktree) gitdir; its presence
      // distinguishes a real git dir from an arbitrary directory the pointer
      // happened to name.
      if (!(await isRegularFile(join(gitDir, "HEAD")))) {
        return undefined;
      }
      try {
        const marker = await readFile(join(gitDir, "commondir"), {
          encoding: "utf8",
          signal: AbortSignal.timeout(GIT_CONFIG_READ_TIMEOUT_MS)
        });
        const common = marker.trim();
        commonDir = isAbsolute(common) ? common : join(gitDir, common);
      } catch {
        commonDir = gitDir;
      }
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return commonDir;
}

/**
 * Minimal git-config reader for the `[remote "origin"]`/`url` entry — enough
 * for the one key repo-auth (or any embedder) needs. Handles quoted section
 * names and values; comments at line start; case-sensitive section names are
 * not matched, only `remote "<name>"` sections.
 */
export function parseGitConfig(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let currentRemote: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const sectionMatch = /^\[(.+)]$/.exec(line);
    if (sectionMatch) {
      const header = sectionMatch[1].trim();
      const subsection = /^remote\s+"([^"]+)"$/.exec(header);
      currentRemote = subsection?.[1];
      if (currentRemote) {
        sections.set(`remote.${currentRemote}`, new Map());
      }
      continue;
    }
    if (!currentRemote) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    sections.get(`remote.${currentRemote}`)?.set(key, value);
  }
  return sections;
}

/** Extract the raw `origin` remote URL from git-config text, if any. */
export function parseOriginRemote(configText: string): string | undefined {
  return parseGitConfig(configText).get("remote.origin")?.get("url");
}

/**
 * Normalize a git remote URL to a `<host>/<path>` string safe for logging and
 * repo correlation:
 *   - strips userinfo (`user@` / `user:pass@`) in both https and scp forms,
 *   - folds scp-style `git@host:org/repo.git` onto the https shape,
 *   - drops a trailing `.git` and any trailing slashes,
 *   - drops query / fragment.
 * Returns `undefined` for anything that is not a recognizable remote (local
 * paths, garbage) — callers treat that as "no remote".
 */
export function normalizeRemote(url: string): string | undefined {
  const candidate = url.trim();
  if (!candidate) {
    return undefined;
  }

  // scp-like: [user@]host:path — the path must not start with `/` so a
  // `scheme://…` URL (whose colon sits right before `//`) does not match.
  const scp = /^(?:[^@/]+@)?([^:/]+):([^/].*)$/.exec(candidate);
  if (scp) {
    const path = stripDotGit(scp[2].split(/[?#]/, 1)[0]);
    return path ? `${scp[1]}/${path}` : scp[1];
  }

  if (/^[\w+.-]+:\/\//.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname) {
        const path = stripDotGit(parsed.pathname.replace(/^\/+/, ""));
        return path ? `${parsed.hostname}/${path}` : parsed.hostname;
      }
    } catch {
      // Not a parseable absolute URL — fall through to undefined.
    }
  }

  return undefined;
}

function stripDotGit(path: string): string {
  let cleaned = path;
  while (cleaned.endsWith("/")) {
    cleaned = cleaned.slice(0, -1);
  }
  if (cleaned.endsWith(".git")) {
    cleaned = cleaned.slice(0, -4);
  }
  while (cleaned.endsWith("/")) {
    cleaned = cleaned.slice(0, -1);
  }
  return cleaned;
}

/** Read the normalized `origin` remote for a repo root, if any. */
export async function resolveOriginRemote(repoRoot: string): Promise<string | undefined> {
  const commonDir = await resolveGitCommonDir(repoRoot);
  if (!commonDir) {
    return undefined;
  }
  const configPath = join(commonDir, "config");
  // Only regular files: a crafted `.git` pointer must not let the plugin hang
  // on a FIFO read or follow a symlink to an arbitrary file.
  if (!(await isRegularFile(configPath))) {
    return undefined;
  }
  let configText: string | undefined;
  try {
    const configStats = await stat(configPath);
    if (configStats.size > GIT_CONFIG_MAX_BYTES) {
      return undefined;
    }
    configText = await readFile(configPath, {
      encoding: "utf8",
      signal: AbortSignal.timeout(GIT_CONFIG_READ_TIMEOUT_MS)
    });
  } catch {
    return undefined;
  }
  if (!configText) {
    return undefined;
  }
  const raw = parseOriginRemote(configText);
  return raw ? normalizeRemote(raw) : undefined;
}
