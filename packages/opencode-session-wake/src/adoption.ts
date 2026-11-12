import type { SubscriptionRecord, WakeProject } from "./types.js";

/**
 * How a watch relates to the session asking to adopt it.
 *
 * - `owner` — the calling session already owns it; adoption is a no-op.
 * - `same-project` — the record carries the same project identity as the caller.
 * - `legacy-same-state-root` — the record predates project identity. It lives in
 *   this plugin's state directory, which is the only scope an older record can
 *   be attributed to, so it is adoptable from this state root. The limitation is
 *   documented: a legacy record cannot prove which project created it.
 * - `cross-project` — the record names a different project. Never adoptable.
 */
export type AdoptionScope = "owner" | "same-project" | "legacy-same-state-root" | "cross-project";

function normalizePath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

/**
 * Identity keys a project can be matched by. The host's project id is the
 * primary identity; the canonical and working directories are kept as a
 * fallback for records written before an id was available, and to match a
 * worktree to its project (same id/canonical, different working directory).
 */
function projectKeys(project: WakeProject): string[] {
  const keys: string[] = [];
  // `global` is the host's sentinel for a session that is not inside a project;
  // it must not make two unrelated directories look like one project.
  if (project.id.length > 0 && project.id !== "global") {
    keys.push(`id:${project.id}`);
  }
  if (project.canonical !== undefined && project.canonical.length > 0) {
    keys.push(`canonical:${normalizePath(project.canonical)}`);
  }
  if (project.directory.length > 0) {
    keys.push(`directory:${normalizePath(project.directory)}`);
  }
  return keys;
}

/** Two identities describe the same project when any of their keys match. */
export function sameProject(a: WakeProject, b: WakeProject): boolean {
  const other = new Set(projectKeys(b));
  return projectKeys(a).some((key) => other.has(key));
}

/**
 * Decide whether `record` may be adopted by `sessionID` in `project`.
 *
 * A missing `project` on the caller is treated as "cannot prove", so a record
 * that *does* carry a project identity is refused. In the plugin the identity
 * is always resolved from `ctx.location` (or the working directory fallback).
 */
export function adoptionScope(
  record: SubscriptionRecord,
  sessionID: string,
  project?: WakeProject
): AdoptionScope {
  if (record.subscription.sessionID === sessionID) {
    return "owner";
  }
  if (record.subscription.project === undefined) {
    return "legacy-same-state-root";
  }
  if (project === undefined) {
    return "cross-project";
  }
  return sameProject(record.subscription.project, project) ? "same-project" : "cross-project";
}

/** `owner` is not adoptable because it needs no change; the other two are. */
export function isAdoptable(scope: AdoptionScope): boolean {
  return scope === "same-project" || scope === "legacy-same-state-root";
}

/** A stable, log-safe description of a project identity. */
export function projectLabel(project: WakeProject | undefined): string {
  if (!project) {
    return "unknown (legacy)";
  }
  return project.canonical ?? project.directory;
}
