# Documentation

The docs map for this workspace. Start with the [root README](../README.md) for the overview and
install; come here when you need depth on a specific topic.

## By plugin

### `@vymalo/opencode-oauth2` — OAuth2/OIDC auth + model discovery
| Page | When you need it |
| --- | --- |
| [architecture.md](architecture.md) | Hooks, token lifecycle per flow, cache layout, sync scheduler, logging |
| [well-known.md](well-known.md) | `.well-known/opencode` distribution — `auth login`, placeholder-key pattern, where config & tokens live |
| [github-actions.md](github-actions.md) | CI without stored secrets — IdP setup, reusable workflow, matrix, fork-PR limits |
| [kubernetes.md](kubernetes.md) | `CronJob` / `Job` / `Deployment` with projected SA tokens, multi-provider pods, RBAC |
| [local-development.md](local-development.md) | Sandbox setup, re-export trick, forcing re-auth, dev-only subject token |

### `@vymalo/opencode-provider-sync` — shared provider-registration + model-sync engine
| Page | When you need it |
| --- | --- |
| [provider-sync.md](provider-sync.md) | What the engine provides, what it deliberately doesn't own (config-key literals, auth-subset validation, the Responses-API repair hook), cross-process token safety, the scheduler-ownership guard, usage, consumers (oauth2 + lightbridge's `register`) |
| [adr/0016-provider-sync-extraction.md](adr/0016-provider-sync-extraction.md) | Why it was extracted from `opencode-oauth2` and what stays behind |
| [adr/0017-lightbridge-all-in-one.md](adr/0017-lightbridge-all-in-one.md) | The second consumer (lightbridge's `register`) and the scheduler-ownership guard it motivated |

### `@vymalo/opencode-models-info` — metadata enrichment
| Page | When you need it |
| --- | --- |
| [models-info.md](models-info.md) | Composition with any auth scheme, the OpenRouter→OpenCode field mapping, caching, failure modes |

### `@vymalo/opencode-ratelimit` — rate-limit awareness
| Page | When you need it |
| --- | --- |
| [ratelimit.md](ratelimit.md) | Reading Envoy `x-ratelimit-*` headers, throttle/backoff state machine, tiers & scope, the timeout caveat |

### `@vymalo/opencode-browser` (+ `-mcp`) — browser automation
| Page | When you need it |
| --- | --- |
| [browser.md](browser.md) | Topology, wire protocol, the 33-tool reference, executors, named groups, multi-client routing, store publishing |
| [`../plans/multi-client-routing.md`](../plans/multi-client-routing.md) | The auto-elect broker design (multiple browsers + agents) |

### `@vymalo/opencode-otel` — OpenTelemetry export
| Page | When you need it |
| --- | --- |
| [otel.md](otel.md) | Config (opencode.json + `OTEL_*`) and precedence, every metric/log/span and its attributes, trace-context propagation, privacy & cardinality, backend recipes |
| [`../plans/otel.md`](../plans/otel.md) | Design rationale, the build-vs-adopt sweep, and the OpenCode-event → OTel-signal mapping |

### `@vymalo/opencode-repo-auth` — repo-as-project attribution
| Page | When you need it |
| --- | --- |
| [repo-auth.md](repo-auth.md) | Enrolling a repo, the RFC 8693 `project_id` exchange flow, the human-root cache, the model-b renewal policy, the auth-core gap |
| [adr/0011-repo-auth-project-id-token-exchange.md](adr/0011-repo-auth-project-id-token-exchange.md) | Why a single exchange presenting `project_id` (no `audience`, no mint step) and the fail-closed posture |

### `@vymalo/opencode-lightbridge` — the all-in-one plugin
| Page | When you need it |
| --- | --- |
| [lightbridge.md](lightbridge.md) | The umbrella plugin: `register` (provider registration + model discovery), the shared gateway bearer + OTEL export credential, the shared root-token cache with oauth2, the opt-in RFC 8693 exchange, config reference, migration notes |
| [adr/0012-single-auth-across-gateway-and-otel.md](adr/0012-single-auth-across-gateway-and-otel.md) | Why one runtime, why MCP is out of scope, the alternatives considered |
| [adr/0017-lightbridge-all-in-one.md](adr/0017-lightbridge-all-in-one.md) | `register`, the shared cache with oauth2, and the exchange becoming opt-in — amends ADR-0012 |

## Cross-cutting

| Page | What it covers |
| --- | --- |
| [security.md](security.md) | Consolidated security model across all plugins — token cache, the browser bridge, blast radius, reducing it |
| [troubleshooting.md](troubleshooting.md) | Symptom-keyed fixes across every plugin |
| [adr/](adr/) | Architecture Decision Records — load-bearing, non-obvious decisions and *why* (e.g. [why the browser bridge uses `ws`, not `Bun.serve` or socket.io](adr/0001-bridge-transport-ws-not-bun-serve-or-socketio.md)) |

## Repo-level

| Page | What it covers |
| --- | --- |
| [../README.md](../README.md) | Overview, install, stacking the plugins, workspace layout |
| [../GETTING_STARTED.md](../GETTING_STARTED.md) | End-to-end setup against a local OpenCode install |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Bootstrap, the pre-push gate, conventions, package layout, releasing |
| [../CLAUDE.md](../CLAUDE.md) | The live architectural map (canonical for hook behavior & composition contracts) |
| [../plans/prd.md](../plans/prd.md) | Product requirements & phased roadmap |
