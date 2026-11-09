export {
  OpencodeRepoAuthPlugin,
  PLUGIN_ID,
  collectManagedProviders,
  createOpencodeRepoAuthPlugin,
  type ManagedProvider,
  type OpenCodePluginFactoryOptions,
  type ProviderView
} from "./opencode.js";
export {
  RepoAuthPlugin,
  isProjectTokenUsable,
  HUMAN_IDENTITY,
  DEFAULT_CACHE_NAMESPACE,
  repoAuthStateDir,
  type RepoAuthPluginOptions
} from "./plugin.js";
export {
  REPO_AUTH_SETTINGS_KEY,
  parseRepoAuthSettings,
  hasOAuth2Conflict,
  type ProviderOwnership,
  type RepoAuthConfig,
  type RepoAuthParseResult
} from "./config.js";
export {
  normalizeRemote,
  parseGitConfig,
  parseOriginRemote,
  resolveOriginRemote,
  resolveRepoRoot
} from "./git.js";
