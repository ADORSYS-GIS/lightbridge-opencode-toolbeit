import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** What we can learn about the checkout without shelling out to `git`. */
export interface VcsInfo {
  /** Remote URL with any credentials stripped. */
  url?: string;
  /** Repository name, e.g. `lightbridge-opencode-toolbeit`. */
  name?: string;
  /** Owning org or user, e.g. `ADORSYS-GIS`. */
  owner?: string;
  /** `github` | `gitlab` | `bitbucket` | `gitea`, when the host says so. */
  provider?: string;
  /** Current branch or tag name. Absent on a detached HEAD. */
  ref?: string;
  /** `branch` or `tag`. */
  refType?: string;
  /** Full commit SHA of HEAD. */
  revision?: string;
}

/** Injectable reader so tests exercise the parsing without a real repository. */
export type FileReader = (path: string) => Promise<string>;

const defaultReader: FileReader = (path) => readFile(path, "utf8");

const PROVIDERS: Array<[RegExp, string]> = [
  [/(^|\.)github\.com$/i, "github"],
  [/(^|\.)gitlab\.com$/i, "gitlab"],
  [/(^|\.)bitbucket\.org$/i, "bitbucket"],
  [/(^|\.)gitea\./i, "gitea"]
];

/**
 * Strip credentials and normalise a git remote to something safe to export.
 *
 * The userinfo component is dropped **unconditionally**. A remote of the form
 * `https://user:ghp_xxx@github.com/org/repo.git` is entirely ordinary in a CI
 * checkout, and that token would otherwise be published as a resource attribute
 * on every span, metric and log the process emits. Nothing in the userinfo
 * identifies the repository, so there is no value being traded away.
 *
 * scp-like SSH remotes (`git@github.com:org/repo.git`) are rewritten to an
 * `ssh://` URL rather than to `https://` — the transport is a fact about the
 * checkout, and inventing a different scheme would misreport it.
 */
export function sanitizeRemoteUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return undefined;
  }

  // scp-like syntax has no scheme and a `:` separating host from path.
  const scpLike = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  const normalized =
    scpLike && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
      ? `ssh://${scpLike[2]}/${scpLike[3]}`
      : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    // A local path (`/srv/git/repo.git`) or something unparseable: report
    // nothing rather than guessing at its shape.
    return undefined;
  }

  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\.git\/?$/, "");
  return parsed.toString().replace(/\/$/, "");
}

/** Split `https://github.com/org/repo` into its owner, name and provider. */
export function describeRemote(url: string): Pick<VcsInfo, "name" | "owner" | "provider"> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {};
  }
  const segments = parsed.pathname.split("/").filter((s) => s !== "");
  const provider = PROVIDERS.find(([pattern]) => pattern.test(parsed.hostname))?.[1];
  return {
    ...(segments.length > 0 ? { name: segments[segments.length - 1] } : {}),
    ...(segments.length > 1 ? { owner: segments[segments.length - 2] } : {}),
    ...(provider ? { provider } : {})
  };
}

/** Pull the `origin` remote out of a git config, falling back to the first one. */
export function parseRemoteFromConfig(config: string): string | undefined {
  const remotes = new Map<string, string>();
  let current: string | undefined;

  for (const line of config.split("\n")) {
    const section = /^\s*\[remote\s+"([^"]+)"\]/.exec(line);
    if (section) {
      current = section[1];
      continue;
    }
    if (/^\s*\[/.test(line)) {
      current = undefined;
      continue;
    }
    const url = current ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line) : null;
    if (url && current && !remotes.has(current)) {
      remotes.set(current, url[1]);
    }
  }

  return remotes.get("origin") ?? remotes.values().next().value;
}

/**
 * Resolve the git directory for a checkout.
 *
 * `.git` is a **file** rather than a directory in a linked worktree or a
 * submodule — it holds `gitdir: <path>`. This repository's own development
 * happens in worktrees, so treating `.git` as always-a-directory would report
 * nothing precisely where it is most used.
 *
 * Returns both the worktree's own git dir (which owns `HEAD`) and the common
 * dir (which owns `config` and `packed-refs`); for a plain clone they are the
 * same path.
 */
export async function resolveGitDirs(
  start: string,
  read: FileReader = defaultReader
): Promise<{ gitDir: string; commonDir: string } | undefined> {
  let gitDir: string | undefined;

  try {
    const pointer = await read(join(start, ".git"));
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
    if (match) {
      gitDir = isAbsolute(match[1]) ? match[1] : resolve(start, match[1]);
    }
  } catch {
    // Either `.git` is a directory (reading it as a file throws EISDIR) or the
    // path does not exist. Probe for the directory form below.
  }

  if (!gitDir) {
    try {
      await read(join(start, ".git", "HEAD"));
      gitDir = join(start, ".git");
    } catch {
      return undefined;
    }
  }

  let commonDir = gitDir;
  try {
    const common = (await read(join(gitDir, "commondir"))).trim();
    if (common !== "") {
      commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
    }
  } catch {
    // No `commondir` means this is not a linked worktree.
  }

  return { gitDir, commonDir };
}

async function readRevision(
  ref: string,
  gitDir: string,
  commonDir: string,
  read: FileReader
): Promise<string | undefined> {
  for (const base of new Set([gitDir, commonDir])) {
    try {
      const sha = (await read(join(base, ref))).trim();
      if (/^[0-9a-f]{40,64}$/i.test(sha)) {
        return sha;
      }
    } catch {
      // Loose ref absent — fall through to packed-refs.
    }
  }

  try {
    const packed = await read(join(commonDir, "packed-refs"));
    for (const line of packed.split("\n")) {
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref && /^[0-9a-f]{40,64}$/i.test(sha)) {
        return sha;
      }
    }
  } catch {
    // No packed-refs either.
  }
  return undefined;
}

/**
 * Read repository metadata straight off disk. Never spawns `git`: the plugin
 * runs inside the host's process on every session start, and a subprocess there
 * costs more than the data is worth — and would fail wherever `git` is not on
 * `PATH` while the files are right there.
 *
 * Every field is independent and best-effort. A repository with no remote still
 * reports its branch; an unreadable config loses only the remote.
 */
export async function readVcsInfo(
  start: string | undefined,
  read: FileReader = defaultReader
): Promise<VcsInfo> {
  if (!start) {
    return {};
  }

  const dirs = await resolveGitDirs(start, read);
  if (!dirs) {
    return {};
  }
  const { gitDir, commonDir } = dirs;
  const info: VcsInfo = {};

  try {
    const url = parseRemoteFromConfig(await read(join(commonDir, "config")));
    const sanitized = url ? sanitizeRemoteUrl(url) : undefined;
    if (sanitized) {
      info.url = sanitized;
      Object.assign(info, describeRemote(sanitized));
    }
  } catch {
    // No readable config.
  }

  try {
    const head = (await read(join(gitDir, "HEAD"))).trim();
    const symbolic = /^ref:\s*(.+)$/.exec(head);
    if (symbolic) {
      const ref = symbolic[1].trim();
      const tag = ref.startsWith("refs/tags/");
      info.ref = ref.replace(/^refs\/(heads|tags)\//, "");
      info.refType = tag ? "tag" : "branch";
      info.revision = await readRevision(ref, gitDir, commonDir, read);
    } else if (/^[0-9a-f]{40,64}$/i.test(head)) {
      // Detached HEAD: there is a revision but no ref name to report.
      info.revision = head;
    }
  } catch {
    // No readable HEAD.
  }

  return info;
}
