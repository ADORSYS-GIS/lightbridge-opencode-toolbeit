# Kubernetes cookbook

Production patterns for running `@vymalo/opencode-oauth2` from inside a pod, with the pod's projected ServiceAccount token serving as the subject token for an RFC 7523 `jwt_bearer` (or RFC 8693 `token_exchange`) grant. No client secrets in the cluster.

If you're new to projected SA tokens, the relevant primitive is [`serviceAccountToken` volume sources](https://kubernetes.io/docs/concepts/storage/projected-volumes/#serviceaccounttoken). The kubelet refreshes the file in place; the plugin re-reads it on every access-token expiry via `subjectTokenSource: { type: "kubernetes_sa" }`. Rotation is transparent — no pod restart needed.

The default token mount path is `/var/run/secrets/tokens/oauth2/token` (`DEFAULT_K8S_SA_TOKEN_PATH` in [`config.ts`](../packages/opencode-oauth2/src/config.ts)). Override with `subjectTokenSource: { type: "kubernetes_sa", tokenPath: "/your/path" }`.

## CronJob — scheduled AI task

The headline use case. Run a scheduled summarization / report / analytics job that needs an LLM but has no human in the loop.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: opencode-daily-digest
  namespace: ai-jobs
spec:
  # 09:00 UTC every weekday — adjust to your timezone via your scheduler's quirks
  # (CronJob.spec.timeZone requires k8s 1.27+; otherwise it's UTC).
  schedule: "0 9 * * 1-5"
  timeZone: "Etc/UTC"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 1
      activeDeadlineSeconds: 1800
      template:
        spec:
          serviceAccountName: opencode-runner
          restartPolicy: Never
          containers:
            - name: runner
              image: ghcr.io/your-org/opencode-with-plugin:0.2.0
              imagePullPolicy: IfNotPresent
              env:
                - name: OPENCODE_CONFIG_DIR
                  value: /etc/opencode
                # Force non-interactive so the plugin never tries TTY warmup
                # logic — CronJobs run with no stdin attached but some shells
                # mis-report isTTY. Belt-and-braces; the default detection is
                # usually right.
                - name: CI
                  value: "true"
              command:
                - /bin/sh
                - -c
                - |
                  set -eu
                  opencode run \
                    --model "miaou/glm-5" \
                    "Summarize yesterday's customer support tickets and post the top 5 to #support-digest"
              resources:
                requests:
                  cpu: 100m
                  memory: 256Mi
                limits:
                  cpu: 500m
                  memory: 1Gi
              volumeMounts:
                - name: oauth2-token
                  mountPath: /var/run/secrets/tokens/oauth2
                  readOnly: true
                - name: opencode-config
                  mountPath: /etc/opencode
                  readOnly: true
                - name: opencode-cache
                  mountPath: /root/.cache/opencode-oauth2
          volumes:
            - name: oauth2-token
              projected:
                sources:
                  - serviceAccountToken:
                      path: token
                      # MUST match what your IdP expects in the JWT `aud` claim.
                      # See docs/architecture.md and your IdP setup below.
                      audience: https://auth.example.com/realms/prod
                      # 1 hour is the default; tune for your job duration.
                      expirationSeconds: 3600
            - name: opencode-config
              configMap:
                name: opencode-config
            # emptyDir so the access-token cache is per-pod-instance. For a
            # short CronJob there's nothing to cache between runs — each pod
            # gets a fresh token. Use a PVC if you want cache survival across
            # pod restarts (rare for CronJobs).
            - name: opencode-cache
              emptyDir: {}
```

ConfigMap for `OPENCODE_CONFIG_DIR`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: opencode-config
  namespace: ai-jobs
data:
  opencode.json: |
    {
      "$schema": "https://opencode.ai/config.json",
      "plugins": [{ "package": "@vymalo/opencode-oauth2" }],
      "providers": {
        "miaou": {
          "name": "Miaou",
          "settings": {
            "baseURL": "https://api.example.com/v1",
            "oauth2": {
              "issuer": "https://auth.example.com/realms/prod",
              "clientId": "k8s-runner",
              "scopes": ["openid"],
              "authFlow": "jwt_bearer",
              "subjectTokenSource": {
                "type": "kubernetes_sa"
              }
            }
          }
        }
      }
    }
```

ServiceAccount (no RBAC bindings needed — see [RBAC](#rbac) below):

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: opencode-runner
  namespace: ai-jobs
```

## Job — one-shot task

The minimum example, comparable to what's in the package README. Useful for ad-hoc tasks driven by `kubectl create -f ...`.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: opencode-summarize-incident
  namespace: ai-jobs
spec:
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      serviceAccountName: opencode-runner
      restartPolicy: Never
      containers:
        - name: runner
          image: ghcr.io/your-org/opencode-with-plugin:0.2.0
          env:
            - name: OPENCODE_CONFIG_DIR
              value: /etc/opencode
          command: ["opencode", "run", "--model", "miaou/glm-5", "summarize incident-1234"]
          volumeMounts:
            - { name: oauth2-token, mountPath: /var/run/secrets/tokens/oauth2, readOnly: true }
            - { name: opencode-config, mountPath: /etc/opencode, readOnly: true }
      volumes:
        - name: oauth2-token
          projected:
            sources:
              - serviceAccountToken:
                  path: token
                  audience: https://auth.example.com/realms/prod
                  expirationSeconds: 3600
        - name: opencode-config
          configMap:
            name: opencode-config
```

## Deployment — long-running pod

For an opencode-backed HTTP service (e.g. a Slack bot, an internal API wrapper) running for days at a time. **The key point: token rotation is fully transparent.**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: opencode-bot
  namespace: ai-jobs
spec:
  replicas: 2
  selector:
    matchLabels:
      app: opencode-bot
  template:
    metadata:
      labels:
        app: opencode-bot
    spec:
      serviceAccountName: opencode-runner
      containers:
        - name: bot
          image: ghcr.io/your-org/opencode-bot:0.5.0
          ports:
            - containerPort: 8080
          env:
            - name: OPENCODE_CONFIG_DIR
              value: /etc/opencode
          readinessProbe:
            httpGet: { path: /healthz, port: 8080 }
          volumeMounts:
            - { name: oauth2-token, mountPath: /var/run/secrets/tokens/oauth2, readOnly: true }
            - { name: opencode-config, mountPath: /etc/opencode, readOnly: true }
      volumes:
        - name: oauth2-token
          projected:
            sources:
              - serviceAccountToken:
                  path: token
                  audience: https://auth.example.com/realms/prod
                  # 1 hour. Kubelet refreshes the file ~80% through its lifetime.
                  expirationSeconds: 3600
        - name: opencode-config
          configMap:
            name: opencode-config
```

### How rotation actually works

1. Pod starts; kubelet writes a JWT to `/var/run/secrets/tokens/oauth2/token` valid for `expirationSeconds`.
2. Plugin reads it on first auth, exchanges for an access token (also typically 1 hour), caches the access token in `~/.cache/opencode-oauth2/...`.
3. Access token nears expiry → `isTokenValid` returns false → `loginJwtBearer()` → `resolveSubjectToken()` re-reads the file → kubelet may have already rotated it (no-op for the plugin) → POST to IdP → new access token.
4. Kubelet rotates the projected JWT in place, atomically. The plugin sees the new contents on the next read.

**No pod restart is needed.** If you ever do see auth failures correlated with the SA token's `expirationSeconds` boundary, check kubelet logs for `TokenProjection` errors — the kubelet is responsible for keeping the file fresh.

## Multiple providers in one pod

Different audiences, different mount paths, different `subjectTokenSource.tokenPath` per provider entry:

```yaml
# In the Deployment / Job / CronJob spec:
      volumes:
        - name: oauth2-tokens
          projected:
            sources:
              - serviceAccountToken:
                  path: prod-token
                  audience: https://auth-prod.example.com/realms/main
                  expirationSeconds: 3600
              - serviceAccountToken:
                  path: staging-token
                  audience: https://auth-staging.example.com/realms/main
                  expirationSeconds: 3600
        - name: opencode-config
          configMap:
            name: opencode-config
      containers:
        - name: bot
          volumeMounts:
            - { name: oauth2-tokens, mountPath: /var/run/secrets/tokens/oauth2, readOnly: true }
            - { name: opencode-config, mountPath: /etc/opencode, readOnly: true }
```

ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: opencode-config
  namespace: ai-jobs
data:
  opencode.json: |
    {
      "$schema": "https://opencode.ai/config.json",
      "plugins": [{ "package": "@vymalo/opencode-oauth2" }],
      "providers": {
        "miaou-prod": {
          "name": "Miaou (prod)",
          "settings": {
            "baseURL": "https://api-prod.example.com/v1",
            "oauth2": {
              "issuer": "https://auth-prod.example.com/realms/main",
              "clientId": "k8s-bot",
              "scopes": ["openid"],
              "authFlow": "jwt_bearer",
              "subjectTokenSource": {
                "type": "kubernetes_sa",
                "tokenPath": "/var/run/secrets/tokens/oauth2/prod-token"
              }
            }
          }
        },
        "miaou-staging": {
          "name": "Miaou (staging)",
          "settings": {
            "baseURL": "https://api-staging.example.com/v1",
            "oauth2": {
              "issuer": "https://auth-staging.example.com/realms/main",
              "clientId": "k8s-bot",
              "scopes": ["openid"],
              "authFlow": "jwt_bearer",
              "subjectTokenSource": {
                "type": "kubernetes_sa",
                "tokenPath": "/var/run/secrets/tokens/oauth2/staging-token"
              }
            }
          }
        }
      }
    }
```

Each provider's token has its own audience, so a token leaked from the staging pod can't be replayed against prod IdP trust.

## IdP setup (Keycloak / Dex)

Your IdP needs to trust the cluster's OIDC issuer.

### 1. Discover the cluster's issuer

```sh
kubectl get --raw /.well-known/openid-configuration | jq .
```

Look for `issuer`. Examples:

- GKE: `https://container.googleapis.com/v1/projects/<project>/locations/<zone>/clusters/<cluster>`
- EKS: `https://oidc.eks.<region>.amazonaws.com/id/<id>`
- AKS: `https://<region>.oic.prod-aks.azure.com/<tenant>/<uuid>/`
- self-managed: whatever `kube-apiserver --service-account-issuer` was set to (commonly `https://kubernetes.default.svc`, which won't resolve outside the cluster — you must run a public-issuer setup for the IdP to fetch JWKS).

For self-managed clusters where the IdP can't reach the apiserver, you typically front the `/.well-known/openid-configuration` + `/openid/v1/jwks` paths with a public mirror (S3, a public ingress, etc.) — see [kubernetes/cloud-provider-oidc-discovery-mirror](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/#service-account-issuer-discovery).

### 2. Register with Keycloak

Same pattern as the GitHub Actions setup (see [docs/github-actions.md#keycloak](./github-actions.md#keycloak)):

- **Realm → Identity Providers → Add → OpenID Connect v1.0.**
- **Discovery endpoint:** `<cluster-issuer>/.well-known/openid-configuration`.
- Client with **Token Exchange** capability enabled.
- Pin the audience to the IdP's expected value (must equal what you put in `serviceAccountToken.audience`).

### 3. Register with Dex

Dex's [federated-token connector](https://dexidp.io/docs/connectors/) handles trusting external OIDC issuers. The relevant config block:

```yaml
connectors:
  - type: oidc
    id: kubernetes
    name: Kubernetes
    config:
      issuer: https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE
      clientID: dex
      clientSecret: ...
      insecureEnableGroups: false
```

For a fuller Dex walkthrough see https://dexidp.io/docs/.

## RBAC

**The ServiceAccount needs no Kubernetes RBAC permissions.** The projected token feature is unrelated to RBAC — any default SA can have a projected token mount, and the projected token's audience claim is independent of any RoleBinding / ClusterRoleBinding the SA has on the kube-apiserver.

Concretely: the SA does not need `get`/`list`/`watch` on anything. It does not even need to be authorized to talk to the kube-apiserver. Its only role is *being the identity the projected token attests to*.

If you find yourself reaching for `ClusterRoleBinding`, stop. You almost certainly don't need it. The exception is if you're additionally using the cluster's kube-apiserver as the OIDC issuer your IdP federates from (you are), and that requires nothing on the SA's side — the kubelet talks to the apiserver, not your pod.

## OpenShift

OpenShift's defaults around projected tokens are largely identical (it ships with the `TokenRequest` API enabled). The notable differences:

- The default audience for SA tokens minted via `oc create token` is the cluster's own apiserver, not arbitrary. You must explicitly specify `--audience` when scripting, and the projected volume's `audience:` field works the same way as in upstream k8s.
- SCC (SecurityContextConstraints) may restrict `volumeTypes` — by default `projected` is included in `restricted-v2`, but a hardened SCC could remove it. Check with `oc adm policy who-can use scc/<your-scc>`.

For OpenShift-specific quirks beyond projected tokens (custom CA bundles, idle pod eviction policies, ServiceAccount kubeconfigs), check Red Hat's docs — the maintainer hasn't validated this end-to-end on OpenShift, so don't assume parity with upstream Kubernetes without testing.
