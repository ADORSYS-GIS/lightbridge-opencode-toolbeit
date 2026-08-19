export interface OidcMetadata {
  issuer: string;
  // RFC 8414 (and OAuth 2.0 Authorization Server Metadata) allow servers that
  // do not support browser-based flows to omit `authorization_endpoint`. The
  // caller is expected to validate that the endpoints needed for its chosen
  // grant are present.
  authorization_endpoint?: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
  jwks_uri?: string;
}

function buildWellKnownUrl(issuer: string): string {
  const normalizedIssuer = issuer.endsWith("/") ? issuer : `${issuer}/`;
  const url = new URL(".well-known/openid-configuration", normalizedIssuer);
  return url.toString();
}

export async function discoverOidcMetadata(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000
): Promise<OidcMetadata> {
  const url = buildWellKnownUrl(issuer);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`OIDC discovery failed (${response.status})`);
    }

    const metadata = (await response.json()) as Partial<OidcMetadata>;
    // Only the token_endpoint is universally required — every grant we support
    // needs it. authorization_endpoint and device_authorization_endpoint are
    // grant-specific; callers validate per their chosen flow.
    if (!metadata.token_endpoint) {
      throw new Error("OIDC metadata is missing token_endpoint");
    }

    return {
      issuer: metadata.issuer ?? issuer,
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
      device_authorization_endpoint: metadata.device_authorization_endpoint,
      jwks_uri: metadata.jwks_uri
    };
  } finally {
    clearTimeout(timeout);
  }
}
