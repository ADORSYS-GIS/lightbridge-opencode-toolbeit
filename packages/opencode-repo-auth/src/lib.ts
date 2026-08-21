export {
  OpencodeRepoAuthPlugin,
  createOpencodeRepoAuthPlugin,
  type OpenCodePluginFactoryOptions
} from "./opencode.js";
export {
  RepoAuthPlugin,
  isProjectTokenUsable,
  HUMAN_IDENTITY,
  DEFAULT_CACHE_NAMESPACE,
  repoAuthCacheDir,
  type RepoAuthPluginOptions
} from "./plugin.js";
export {
  REPO_AUTH_META_KEY,
  parseRepoAuthOptions,
  hasOAuth2Conflict,
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
