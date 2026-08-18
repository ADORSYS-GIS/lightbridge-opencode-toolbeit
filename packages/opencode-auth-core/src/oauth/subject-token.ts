import { readFile } from "node:fs/promises";

import { DEFAULT_K8S_SA_TOKEN_PATH, type SubjectTokenSource } from "../config.js";
import { readResponseBodyPreview, scrubSecrets } from "./http-utils.js";

export interface ResolveSubjectTokenOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Override process.env. Lets tests inject GHA-style env vars without
   * mutating the real environment.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Read the platform-supplied JWT that the plugin will present as the subject
 * token (or assertion) for the `jwt_bearer` and `token_exchange` flows.
 *
 * Each source resolves fresh on every call — we never cache the JWT itself,
 * only the OIDC access token it gets exchanged for. K8s projected SA tokens
 * rotate; GHA OIDC tokens are short-lived (~10 min); both are cheap to
 * re-fetch on demand.
 */
export async function resolveSubjectToken(
  source: SubjectTokenSource,
  options: ResolveSubjectTokenOptions = {}
): Promise<string> {
  switch (source.type) {
    case "github_actions":
      return resolveGithubActionsToken(source.audience, options);
    case "kubernetes_sa":
      return readJwtFile(source.tokenPath ?? DEFAULT_K8S_SA_TOKEN_PATH, "kubernetes_sa");
    case "file":
      return readJwtFile(source.path, "file");
    case "env":
      return resolveEnvToken(source.var, options.env ?? process.env);
  }
}

async function readJwtFile(path: string, sourceLabel: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `subjectTokenSource (${sourceLabel}): no file at ${path} — check the mount/path`
      );
    }
    throw new Error(
      `subjectTokenSource (${sourceLabel}): failed to read ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`subjectTokenSource (${sourceLabel}): file at ${path} is empty`);
  }
  return trimmed;
}

function resolveEnvToken(name: string, env: Record<string, string | undefined>): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`subjectTokenSource (env): ${name} is not set or is empty`);
  }
  return value.trim();
}

async function resolveGithubActionsToken(
  audience: string,
  options: ResolveSubjectTokenOptions
): Promise<string> {
  const env = options.env ?? process.env;
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

  if (!requestUrl || !requestToken) {
    throw new Error(
      `subjectTokenSource (github_actions): ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN must be set — this only works inside a GitHub Actions job with \`permissions: { id-token: write }\``
    );
  }

  const url = new URL(requestUrl);
  url.searchParams.set("audience", audience);

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${requestToken}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const preview = await readResponseBodyPreview(response, 500);
    throw new Error(
      `subjectTokenSource (github_actions): OIDC token request failed (${response.status})${
        preview ? `: ${scrubSecrets(preview)}` : ""
      }`
    );
  }

  const payload = (await response.json()) as { value?: unknown };
  if (typeof payload.value !== "string" || payload.value.length === 0) {
    throw new Error(
      "subjectTokenSource (github_actions): response had no `value` field — GitHub may have changed the API shape"
    );
  }
  return payload.value;
}
