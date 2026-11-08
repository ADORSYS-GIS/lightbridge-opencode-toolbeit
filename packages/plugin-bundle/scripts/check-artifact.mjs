// Post-build guard for @vymalo/opencode-oauth2-bundle.
//
// `effect` and `@opencode/plugin` are supplied by the OpenCode host (ADR-0019).
// Inlining either ships a second copy of `effect` that cannot reach the host's
// log sink — a runtime-only failure no type check or unit test sees. This runs
// on every build (so `pnpm -r build` in CI enforces it) and throws on a leak.

// Deliberately NOT derived from rolldown.config.mjs: the guard must stay
// independent of the config it polices, or a bad config would pass its own check.
export const REQUIRED_EXTERNALS = ["@opencode/plugin", "effect"];

/**
 * @param {string} id
 * @param {ReadonlySet<string>} externalPackages
 * @returns {string | undefined}
 */
function leakedPackage(id, externalPackages) {
  // Module ids are absolute paths; the package is whatever follows the last
  // `node_modules/` segment (pnpm nests: .pnpm/<pkg>@v/node_modules/<pkg>/...).
  const marker = "node_modules/";
  const at = id.lastIndexOf(marker);
  if (at === -1) return undefined;
  const parts = id.slice(at + marker.length).split("/");
  const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  return name && externalPackages.has(name) ? name : undefined;
}

/**
 * @param {{ code: string, moduleIds: readonly string[] }} chunk rolldown output chunk
 * @param {readonly string[]} [required]
 * @returns {void}
 */
export function assertExternalsNotInlined(chunk, required = REQUIRED_EXTERNALS) {
  const externalPackages = new Set(required);
  const leaked = new Set();
  for (const id of chunk.moduleIds) {
    const name = leakedPackage(id.replaceAll("\\", "/"), externalPackages);
    if (name) leaked.add(name);
  }
  const problems = [];
  if (leaked.size > 0) {
    problems.push(`inlined (must be external): ${[...leaked].sort().join(", ")}`);
  }
  for (const pkg of externalPackages) {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const bare = new RegExp(`(?:from|import)\\s*\\(?\\s*["']${escaped}(?:/[^"']*)?["']`);
    if (!bare.test(chunk.code)) problems.push(`no bare import of "${pkg}" in the artifact`);
  }
  if (problems.length > 0) {
    throw new Error(`oauth2-bundle externals check failed:\n  - ${problems.join("\n  - ")}`);
  }
}
