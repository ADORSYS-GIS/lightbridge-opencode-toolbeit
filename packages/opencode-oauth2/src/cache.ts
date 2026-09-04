import { resolveCacheDir as resolveProviderSyncCacheDir } from "@vymalo/opencode-provider-sync/lib";

export { FileCacheStore } from "@vymalo/opencode-provider-sync/lib";

/**
 * oauth2's on-disk cache segment (`<root>/opencode-oauth2/<namespace>`),
 * preserved unchanged across the `@vymalo/opencode-provider-sync` extraction
 * (ADR-0016) so existing installs keep their cached sessions (models + OAuth
 * token) across the upgrade and users are not forced to re-login. The actual
 * `resolveCacheDir` implementation and the `FileCacheStore` class now live in
 * provider-sync; this file only binds oauth2's own segment.
 */
const CACHE_SEGMENT = "opencode-oauth2";

export function resolveCacheDir(namespace: string): string {
  return resolveProviderSyncCacheDir(CACHE_SEGMENT, namespace);
}
