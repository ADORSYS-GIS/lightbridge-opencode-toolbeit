export {
  type BrowserPluginFactoryOptions,
  createBrowserPlugin,
  OpencodeBrowserPlugin,
  PLUGIN_ID
} from "./opencode.js";

export {
  type AgentEndpoint,
  Broker,
  BrokerError,
  type BrokerDeps,
  type BrokerOptions
} from "./broker.js";

export {
  AgentClient,
  AgentClientError,
  type AgentClientDeps,
  type AgentClientOptions,
  type AgentSocket,
  type AgentSocketFactory,
  type AgentSocketHandlers
} from "./agent-client.js";

export {
  createEndpoint,
  type Endpoint,
  type EndpointDeps,
  type EndpointMode,
  type EndpointOptions
} from "./endpoint.js";

export {
  type BridgeTransport,
  type ClientConnection,
  isAddrInUse,
  type TransportHandlers
} from "./transport.js";

export { createNodeAgentSocket, createNodeTransport } from "./node-transport.js";

export {
  type BridgeFile,
  readBridgeFile,
  resolveSharedToken,
  type TokenSource,
  writeBridgeFile
} from "./token-file.js";

export {
  type BrowserToolInfo,
  createBrowserTools,
  type SaveScreenshot,
  type SendFn,
  type ToolDeps
} from "./tools.js";

export {
  type Annotation,
  BROWSER_TOOLS,
  DEFAULT_GROUPS,
  type FeedbackResult,
  type NeutralResult,
  TOOL_GROUPS,
  type ToolGroup,
  type ToolSpec
} from "./catalog.js";

export { type Field, type JsonInput, type JsonSchema, toJsonSchema } from "./schema.js";

export {
  createJsonConsoleLogger,
  DEFAULT_LOG_LEVEL,
  resolveLogLevel,
  type LogFields,
  type Logger,
  type LogLevel
} from "./logging.js";

export {
  BROWSER_ACTIONS,
  type BrowserAction,
  type BrowserEventName,
  type ClientRole,
  type CommandFrame,
  decodeFrame,
  encodeFrame,
  type EventFrame,
  type Frame,
  type HelloFrame,
  helloFrame,
  nextId,
  PROTOCOL_VERSION,
  type ReadyFrame,
  type ResultFrame
} from "./protocol.js";

export type {
  BrowserPluginOptions,
  ExecutorMode,
  ResolvedBrowserOptions,
  ScreenshotResult
} from "./types.js";
