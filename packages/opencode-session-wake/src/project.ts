import { resolve } from "node:path";

import type { WakeProject } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Resolve the identity a new subscription records for adoption after a restart.
 *
 * The host exposes it as `ctx.location.project` (`id`, `directory`, `canonical`)
 * and `ctx.location.directory`. The project id is the primary identity; the
 * absolute directory is always stored too, because it is the fallback a record
 * written by an older version can be matched by and it is the only identity a
 * host that does not expose a project id can give us.
 *
 * A missing project block falls back to the location directory, then to the
 * process working directory, so a new subscription is never written without an
 * identity. The fallback is stable for a given checkout, which is what adoption
 * needs; it is not a security boundary (the state directory is).
 */
export function resolveWakeProject(
  location: unknown,
  fallbackDirectory: string = process.cwd()
): WakeProject {
  const loc = asRecord(location);
  const project = asRecord(loc?.project);
  const directory = resolve(
    nonEmptyString(project?.directory) ?? nonEmptyString(loc?.directory) ?? fallbackDirectory
  );
  const id = nonEmptyString(project?.id) ?? `directory:${directory}`;
  const canonical = nonEmptyString(project?.canonical);
  return {
    id,
    directory,
    ...(canonical !== undefined ? { canonical: resolve(canonical) } : {})
  };
}
