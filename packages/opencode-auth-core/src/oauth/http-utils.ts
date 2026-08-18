/**
 * Strip credentials (`user:pass@`) and the query string from a URL before
 * including it in user-facing error messages or thrown exceptions. The query
 * string can contain access tokens, session ids, or other secrets supplied by
 * caller-controlled config — `baseURL` and `issuer` are not validated as
 * credential-free.
 */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    // Not a parseable URL — strip anything that looks like a query and any
    // userinfo separator, then return.
    return rawUrl
      .replace(/\/\/[^/@]*@/, "//")
      .replace(/\?.*$/, "")
      .replace(/#.*$/, "");
  }
}

/**
 * Read at most `maxChars` characters from a `Response`'s body without
 * buffering the rest. Cancels the underlying stream once the cap is reached so
 * the network isn't drained on a huge error page.
 *
 * Returns an empty string if the body is unreadable or empty.
 */
export async function readResponseBodyPreview(response: Response, maxChars = 500): Promise<string> {
  if (!response.body) {
    // Some runtimes attach the body lazily; fall back to text() but still cap.
    try {
      const text = await response.text();
      return text.slice(0, maxChars);
    } catch {
      return "";
    }
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let collected = "";

  try {
    while (collected.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      collected += decoder.decode(value, { stream: true });
      if (collected.length >= maxChars) {
        collected = collected.slice(0, maxChars);
        break;
      }
    }
  } catch {
    // partial body is fine
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort
    }
  }

  return collected;
}

// Names of token/credential fields commonly echoed back by misbehaving IdPs in
// error responses. Used both for JSON-style ("name":"value") and form-style
// (name=value&...) substitution.
const SECRET_FIELD_NAMES = [
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "client_assertion",
  "code",
  "device_code",
  "password",
  "assertion",
  "subject_token",
  "actor_token"
];

const REDACTED = "[redacted]";

// Pre-built patterns so we don't re-compile on every call.
const SECRET_JSON_PATTERN = new RegExp(
  // "name"  :  "value"      (also handles escaped quotes inside value)
  `("(?:${SECRET_FIELD_NAMES.join("|")})"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`,
  "gi"
);
const SECRET_FORM_PATTERN = new RegExp(
  // name=value (terminated by & or end-of-string)
  `(\\b(?:${SECRET_FIELD_NAMES.join("|")}))=([^&\\s]+)`,
  "gi"
);
// Bearer / Basic prefixes in headers/messages, plus bare JWT-shaped strings.
const BEARER_PATTERN = /\b(Bearer|Basic)\s+([A-Za-z0-9._\-+/=]+)/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

/**
 * Mask token/credential substrings inside an arbitrary text body before it
 * lands in a structured log entry. Field-name-based redaction in upstream
 * loggers only matches whole field NAMES — it does not scrub secrets embedded
 * in arbitrary string VALUES (like an IdP error body that echoes back the
 * client_secret it received).
 *
 * Catches:
 *   - JSON: `"access_token": "..."` and the other SECRET_FIELD_NAMES
 *   - form bodies: `client_secret=...`
 *   - Bearer/Basic auth headers
 *   - bare JWT-shaped strings
 *
 * Anything not matching stays intact, so error messages keep their diagnostic
 * value (status code, error kind, descriptions, etc.).
 */
export function scrubSecrets(text: string): string {
  if (!text) {
    return text;
  }
  return text
    .replace(SECRET_JSON_PATTERN, `$1"${REDACTED}"`)
    .replace(SECRET_FORM_PATTERN, `$1=${REDACTED}`)
    .replace(BEARER_PATTERN, `$1 ${REDACTED}`)
    .replace(JWT_PATTERN, REDACTED);
}
