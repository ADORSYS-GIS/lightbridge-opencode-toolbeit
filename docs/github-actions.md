# GitHub Actions cookbook

Production patterns for running `@vymalo/opencode-oauth2` from CI without baking long-lived API keys into your workflow. The plugin uses the runner's own OIDC token as the subject token for an RFC 7523 `jwt_bearer` (or RFC 8693 `token_exchange`) grant — your OAuth server validates the runner's claims against the GitHub Actions JWKS and mints a short-lived access token.

If you haven't read [`architecture.md`](./architecture.md), skim the "Token lifecycle per flow" section first.

## Why federated identity beats stored secrets

The runner already has a verifiable identity — `https://token.actions.githubusercontent.com` signs a JWT on demand whose claims include `repository`, `workflow`, `ref`, `actor`, `environment`, and an `aud` you choose per job. Your IdP can pin policy to any subset (e.g. *"this client may only be obtained by `repo:vymalo/opencode-oauth2:ref:refs/heads/main`"*). Rotation is free — every workflow run gets a fresh ~10-minute token.

The plugin re-fetches the OIDC token on every access-token expiry (see `resolveSubjectToken` in [`subject-token.ts`](../packages/opencode-oauth2/src/oauth/subject-token.ts)). Nothing is cached except the IdP-issued access token.

## IdP setup

### Keycloak

This is what the maintainer uses in production (`auth.verif.fyi/realms/camer-digital` advertises both `jwt_bearer` and `token_exchange`). Verified end-to-end against that realm.

1. **Realm → Identity Providers → Add → OpenID Connect v1.0.**
   - **Alias:** `github-actions` (anything; referenced internally only).
   - **Discovery endpoint:** `https://token.actions.githubusercontent.com/.well-known/openid-configuration`.
   - **Sync mode:** `IMPORT` or `LEGACY` — your call; the plugin doesn't care.
   - **Trust Email:** off.
   - Save.

2. **Client (the one the plugin uses).**
   - Create a `Public` or `Confidential` client (the plugin supports both — pass `clientSecret` if confidential).
   - **Capability config:**
     - Disable *Standard flow* (no PKCE here — that's for end users).
     - Enable *Service accounts roles* only if you also want `client_credentials` as a fallback.
     - **Enable "OAuth 2.0 Token Exchange"** (Keycloak ≥ 18, under *Capability config → Advanced settings*).
   - **Advanced settings → Token Exchange:** enabled.
   - **Web origins:** leave empty — the plugin never hits the authorization endpoint for this client.

3. **Token Exchange permissions (the part that's easy to miss).**
   - Open the client → *Permissions* → toggle *Permissions Enabled*.
   - Open the `token-exchange` permission → *Policies* → add a *Client* policy targeting your GHA-backed identity provider, plus a *User* or *Group* policy if you want claim-based scoping.
   - Keycloak's *Token Exchange* docs: https://www.keycloak.org/securing-apps/token-exchange

4. **Claim mapping (optional but recommended).**
   - On the GHA identity provider → *Mappers* → *Add mapper* → *Hardcoded attribute* (or *Claim to attribute*) to surface `repository`, `workflow`, `ref` as user attributes you can audit on.

5. **Audience.** The audience your workflow requests (`audience:` in `subjectTokenSource`) must equal the **Identity Provider's `Issuer URL`** field, *not* arbitrary. Keycloak's GHA IdP rejects mismatched `aud`. Pin one audience per workflow — see [audience pinning](#audience-pinning) below.

### Auth0

1. **Applications → APIs → Create API.**
   - Identifier (== audience): `https://api.example.com` (or anything stable you'll pass as `audience`).
   - Token signing: `RS256`.
2. **Applications → Create Application** of type *Machine to Machine* and authorize it for the API above.
3. **Federated identity:** Auth0 supports `urn:ietf:params:oauth:grant-type:jwt-bearer` via the [Custom Database with Custom Token Exchange](https://auth0.com/docs/authenticate/custom-token-exchange) feature (Enterprise). For most teams, point Auth0 at the GitHub Actions JWKS via an [Action](https://auth0.com/docs/customize/actions) on the token-exchange hook and validate the `iss` / `aud` claims explicitly.
4. **Detailed walkthrough:** https://auth0.com/docs/authenticate/custom-token-exchange — covers the policy DSL and rate limits.

### Okta

1. **Security → API → Authorization Servers → Default (or create one) → Claims.** Add a custom claim `repository` mapped from `request.body.assertion.repository` (or whatever Okta is configured to surface from incoming JWTs).
2. **Applications → Create App Integration → API Services.** Generate a client ID/secret pair; this is what the plugin presents as `client_id` (+ `client_secret` if confidential).
3. **Configure JWT Authorization grant.** Okta's docs: https://developer.okta.com/docs/guides/implement-oauth-for-okta-serviceapp/main/ — the *JWT Bearer* path lets you trust an external IdP's signed JWT as the assertion.

For Auth0 and Okta, defer to vendor docs for the up-to-date click path. The relevant invariant is: **your IdP must accept a JWT signed by `https://token.actions.githubusercontent.com` with `aud` equal to your configured audience, and mint a client-credentials-shaped access token in response.**

## The reusable workflow

This repo ships a reusable workflow at [`.github/workflows/opencode-run.yml`](../.github/workflows/opencode-run.yml). Consumers can call it without copy-pasting the setup:

```yaml
name: AI-assisted analysis
on:
  workflow_dispatch:
    inputs:
      prompt:
        description: Prompt to send to opencode
        required: true

permissions:
  id-token: write
  contents: read

jobs:
  run:
    uses: vymalo/opencode-oauth2/.github/workflows/opencode-run.yml@v0.6.1
    with:
      model: miaou/glm-5
      prompt: ${{ inputs.prompt }}
      opencode-config-path: .opencode-ci/opencode.json
```

The reusable workflow handles:

- Installing Node 22.
- Installing the plugin + opencode CLI via the [setup composite action](#composite-action-bring-your-own-job), which caches the global `node_modules` between runs.
- Pointing `OPENCODE_CONFIG_DIR` at the directory you specify.
- Running `opencode run --model "<model>" "<prompt>"`.

You're responsible for committing `.opencode-ci/opencode.json` (or wherever you pointed `opencode-config-path`) with the `authFlow: "jwt_bearer"` config.

## Composite action (bring-your-own-job)

If you need to compose your own job — different runner image, custom pre/post steps, multiple `opencode run` calls in one job — use the composite setup action directly. It installs the plugin (and optionally the CLI) globally and caches the install across runs.

```yaml
- uses: vymalo/opencode-oauth2/.github/actions/setup@v0.6.1
  with:
    node-version: '22'
    install-opencode: 'true'
```

| Input | Default | Purpose |
| --- | --- | --- |
| `version` | `latest` | Plugin version (`"0.6.1"`, `"^0.6.1"`, `"next"`, …). |
| `install-opencode` | `false` | Also install the opencode CLI globally. |
| `opencode-package` | `opencode-ai` | npm package name for the CLI. Override for forks/mirrors. |
| `opencode-version` | `latest` | CLI version. Used only when `install-opencode=true`. |
| `node-version` | _(unset)_ | If set, runs `actions/setup-node@v4` first. Leave empty if you already set up Node. |
| `cache` | `true` | Cache the global install between runs. |

Outputs: `version`, `opencode-version`, `node-path`, `cache-hit`. `NODE_PATH` is exported for subsequent steps so `opencode` finds the plugin no matter what cwd you `cd` to. Full reference in [`.github/actions/setup/README.md`](../.github/actions/setup/README.md).

On a cache hit (same version, same runner OS) the install step is a no-op — useful for high-frequency triggers like `pull_request`.

## Minimal worked example

`.github/workflows/ai.yml` in your repo:

```yaml
name: AI summary
on:
  pull_request:
    types: [opened, synchronize]

permissions:
  id-token: write
  contents: read
  pull-requests: write

jobs:
  summarize:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: vymalo/opencode-oauth2/.github/actions/setup@v0.6.1
        with:
          node-version: '22'
          install-opencode: 'true'
      - run: opencode run --model "miaou/glm-5" "Summarize the changes in this PR" > summary.md
        env:
          OPENCODE_CONFIG_DIR: "${{ github.workspace }}/.opencode-ci"
      - run: gh pr comment ${{ github.event.pull_request.number }} --body-file summary.md
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`.opencode-ci/opencode.json` in your repo (committed):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "@vymalo/opencode-oauth2" }],
  "providers": {
    "miaou": {
      "name": "Miaou",
      "settings": {
        "baseURL": "https://api.example.com/v1",
        "oauth2": {
          "issuer": "https://auth.verif.fyi/realms/camer-digital",
          "clientId": "opencode-ci",
          "scopes": ["openid"],
          "authFlow": "jwt_bearer",
          "subjectTokenSource": {
            "type": "github_actions",
            "audience": "https://auth.verif.fyi/realms/camer-digital"
          }
        }
      }
    }
  }
}
```

No `clientSecret` field anywhere. No secrets in repo settings. The runner's OIDC token authenticates to Keycloak; Keycloak mints an access token for the `opencode-ci` client.

## Matrix builds

One OIDC trust on your IdP, N runners (Linux/macOS, multiple Node versions, etc.). Each matrix leg mints its own OIDC token — no shared state between them.

```yaml
name: AI on many platforms
on: [workflow_dispatch]

permissions:
  id-token: write
  contents: read

jobs:
  run:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: vymalo/opencode-oauth2/.github/actions/setup@v0.6.1
        with:
          node-version: ${{ matrix.node }}
          install-opencode: 'true'
      - run: opencode run --model "miaou/glm-5" "say hi from ${{ matrix.os }} node${{ matrix.node }}"
        env:
          OPENCODE_CONFIG_DIR: "${{ github.workspace }}/.opencode-ci"
```

The OIDC token's `repository` claim is identical across legs; the `run_id` and `job_workflow_ref` vary. If your IdP policy needs to allow all legs, it should match on `repository` and `workflow`, not `run_id`.

## Audience pinning

Use a distinct `audience` per workflow. Why:

- A token minted with `audience: A` cannot be replayed against an IdP trust expecting `audience: B`. Re-use across unrelated workflows is blocked at the JWT-validation layer.
- An attacker who exfiltrates a single workflow's OIDC token gets a credential scoped only to that audience — they can't use it to obtain access tokens for unrelated clients in your IdP.

Concrete pattern:

| Workflow | `audience` value |
| --- | --- |
| `.github/workflows/ai-summary.yml` | `https://auth.example.com/realms/prod/clients/opencode-ai-summary` |
| `.github/workflows/ai-triage.yml` | `https://auth.example.com/realms/prod/clients/opencode-ai-triage` |
| `.github/workflows/nightly-eval.yml` | `https://auth.example.com/realms/prod/clients/opencode-nightly-eval` |

On the IdP side, each audience corresponds to its own IdP-trust → client mapping, so claim-based policy (`repository:foo/bar`, `workflow:.github/workflows/ai-summary.yml`) can be enforced independently per workflow.

Keycloak: each workflow gets its own client with its own *Token Exchange permission* policy. The "audience" you pin in YAML is the value Keycloak expects in the assertion's `aud` claim.

## Fork PR limitations

`id-token: write` is **not** granted to `pull_request` workflows triggered by forks. From [GitHub's docs](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect#using-openid-connect-with-reusable-workflows): pull requests from forked repositories cannot mint OIDC tokens, because the fork could otherwise authenticate as the upstream repo's identity.

Workarounds, in increasing order of risk:

### 1. Run on `push` to `main` after merge

The safest pattern. Your AI workflow runs after a maintainer merges. No fork ever touches `id-token: write`.

```yaml
on:
  push:
    branches: [main]
```

### 2. `pull_request_target` with manual gating

`pull_request_target` runs in the **upstream** repo's context, so `id-token: write` works. But it also gives the workflow access to the upstream's secrets — and by default checks out the upstream's `main`, not the PR. **Never check out and run untrusted PR code** under this trigger.

Gate by maintainer approval:

```yaml
on:
  pull_request_target:
    types: [labeled]

jobs:
  run:
    if: github.event.label.name == 'ai-review-approved'
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        # IMPORTANT: explicitly checkout the upstream ref, NOT the PR head.
        # Code from the PR is treated as untrusted input.
        with:
          ref: ${{ github.event.pull_request.base.ref }}
      - uses: vymalo/opencode-oauth2/.github/actions/setup@v0.6.1
        with:
          node-version: '22'
          install-opencode: 'true'
      # Read the PR diff but do not execute fork-provided code.
      - id: diff
        run: gh pr diff ${{ github.event.pull_request.number }} > /tmp/diff.patch
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - run: |
          opencode run --model "miaou/glm-5" "Review this diff: $(cat /tmp/diff.patch)"
        env:
          OPENCODE_CONFIG_DIR: "${{ github.workspace }}/.opencode-ci"
```

The label-based gate (`if: github.event.label.name == 'ai-review-approved'`) means a maintainer must explicitly opt a PR in. Without it, anyone opening a PR could trigger your AI budget.

### 3. Restricted-scope reusable workflow

If you must run on `pull_request` from forks (e.g. for *limited* AI-driven analysis that doesn't need IdP access), the reusable workflow can downgrade to a non-OAuth provider for fork PRs and only use OAuth on `push`/`workflow_dispatch`:

```yaml
jobs:
  run:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    uses: vymalo/opencode-oauth2/.github/workflows/opencode-run.yml@v0.6.1
    with:
      model: miaou/glm-5
      prompt: ${{ inputs.prompt }}
```

The condition `head.repo.full_name == github.repository` evaluates true only when the PR head is in the same repo (not a fork).

**Honest tradeoff:** any path that grants fork-PR access to a long-lived IdP credential — including the `pull_request_target` pattern above — has to be defended at the IdP policy layer. The plugin can't make that defense for you. Audit Keycloak's `aud` and `repository` claims, set strict policy, and budget for the worst case where a stolen token gets one round trip to your provider before the IdP times out.

## Verifying it works

Run the workflow once manually (`workflow_dispatch`) and look for:

- `oauth_jwt_bearer_started` log event with `subjectTokenSource: "github_actions"`.
- `oauth_jwt_bearer_success` with `hasExpiry: true` (Keycloak issues `expires_in`).
- `sync_success` with a `modelCount > 0`.

If you see `subjectTokenSource (github_actions): ACTIONS_ID_TOKEN_REQUEST_URL ... must be set`, the `permissions: id-token: write` block is missing or you're running under a fork PR — see [Fork PR limitations](#fork-pr-limitations).

If you see `jwt_bearer request failed (401)`, the IdP rejected the assertion — see [troubleshooting](./troubleshooting.md#jwt_bearer-401).
