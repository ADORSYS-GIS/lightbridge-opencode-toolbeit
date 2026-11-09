// Rolldown bundling configuration for @vymalo/opencode-oauth2.
//
// Bundles the TypeScript entry from packages/opencode-oauth2/src/index.ts into
// a single ESM artifact in packages/plugin-bundle/dist/index.mjs. The tsc build
// in opencode-oauth2 remains the development entry; this is the release artifact.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { builtinModules } from "node:module";
import builtins from "builtin-modules";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Externalize: every Node built-in (with and without the `node:` prefix), the
// v2 plugin host SDK (`@opencode/plugin`, incl. its `/effect` subpath) and
// `effect`. Anything else is bundled into the artifact.
//
// `effect` MUST stay external (ADR-0019): it is a peerDependency, the OpenCode
// host supplies the instance, and a second copy cannot reach the host's log
// sink (Effect carries loggers as fiber-level references). The workspace
// packages (`@vymalo/opencode-auth-core`, `@vymalo/opencode-provider-sync`)
// are deliberately bundled — they are private-to-the-artifact implementation.
// `scripts/check-artifact.mjs` fails the build if any of these gets inlined.
const nodeBuiltins = new Set([...builtinModules, ...builtins]);
const externalPackages = new Set(["@opencode/plugin", "effect"]);

/**
 * @param {string} id
 * @returns {boolean}
 */
function isExternal(id) {
  if (id.startsWith("node:")) return true;
  if (nodeBuiltins.has(id)) return true;
  if (externalPackages.has(id)) return true;
  // Treat any subpath of an external package as external too.
  for (const pkg of externalPackages) {
    if (id === pkg || id.startsWith(`${pkg}/`)) return true;
  }
  return false;
}

/** @type {import('rolldown').RolldownOptions} */
const config = {
  input: resolve(__dirname, "../opencode-oauth2/src/index.ts"),
  external: isExternal,
  platform: "node",
  output: {
    file: resolve(__dirname, "dist/index.mjs"),
    format: "esm",
    sourcemap: true,
    exports: "named",
    // Target Node 20+ — preserves modern syntax (top-level await, etc.).
    minify: false
  },
  resolve: {
    extensions: [".ts", ".mts", ".js", ".mjs", ".json"]
  },
  treeshake: true
};

export default config;
