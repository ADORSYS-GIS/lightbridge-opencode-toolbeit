// oauth2's model-sync state types now live in the shared
// `@vymalo/opencode-provider-sync` engine (ADR-0016). Re-exported here
// unchanged so `../src/types.js` keeps resolving for anything that imported
// it directly (in-repo tests included) — no behaviour or shape change.
export type {
  CachedServerState,
  ModelDiff,
  NormalizedModel,
  RawModel,
  ServerSnapshot
} from "@vymalo/opencode-provider-sync/lib";
