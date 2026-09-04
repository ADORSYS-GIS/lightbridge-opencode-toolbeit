import {
  ProviderModelSyncEngine,
  type ProviderModelSyncEngineOptions
} from "@vymalo/opencode-provider-sync/lib";
import { validateConfig, type OAuth2ModelSyncConfigInput } from "./config.js";

/**
 * oauth2's own cache/service-label segment, preserved across the
 * `@vymalo/opencode-provider-sync` extraction (ADR-0016) so an existing
 * install's on-disk cache path (`<root>/opencode-oauth2/<namespace>`) and its
 * `TokenRuntime` log/prompt label are unchanged. The shared engine's own
 * defaults are generic (`"opencode-provider-sync"`) — oauth2 must pin its own
 * literal explicitly rather than rely on them.
 */
const OAUTH2_SEGMENT = "opencode-oauth2";

export type PluginOptions = ProviderModelSyncEngineOptions;

/**
 * Thin subclass over the shared `ProviderModelSyncEngine`: validates oauth2's
 * own config shape (`validateConfig`, unchanged — the auth-subset validation,
 * PKCE/redirect-port bounds and flow-required-field checks all still live in
 * `./config.js`) and hands the engine an already-validated config plus
 * oauth2's cache/service-label identity. No behaviour change from the
 * pre-extraction `OAuth2ModelSyncPlugin` — see ADR-0016.
 */
export class OAuth2ModelSyncPlugin extends ProviderModelSyncEngine {
  constructor(configInput: OAuth2ModelSyncConfigInput, options: PluginOptions = {}) {
    const validated = validateConfig(configInput);
    super(validated, {
      cacheNamespaceSegment: OAUTH2_SEGMENT,
      serviceLabel: OAUTH2_SEGMENT,
      ...options
    });
  }
}
