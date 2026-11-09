import {
  resolveCacheDir as resolveProviderSyncCacheDir,
  resolveStateDir as resolveProviderSyncStateDir
} from "@vymalo/opencode-provider-sync/lib";

export { ServerStateStore } from "@vymalo/opencode-provider-sync/lib";

/**
 * oauth2's on-disk segment (`<root>/opencode-oauth2/<namespace>`), preserved
 * unchanged across the `@vymalo/opencode-provider-sync` extraction (ADR-0016).
 * The same relative path is used under two roots (ADR-0022): the CACHE root
 * holds the disposable discovered-model list, the durable STATE root holds the
 * OAuth credential (and its refresh lock) — the file
 * `@vymalo/opencode-lightbridge` shares for a server of the same id
 * (ADR-0017). The actual resolvers and stores live in provider-sync; this file
 * only binds oauth2's own segment.
 */
const CACHE_SEGMENT = "opencode-oauth2";

export function resolveCacheDir(namespace: string): string {
  return resolveProviderSyncCacheDir(CACHE_SEGMENT, namespace);
}

export function resolveStateDir(namespace: string): string {
  return resolveProviderSyncStateDir(CACHE_SEGMENT, namespace);
}
