export {
  MOTIONPR_DOCS_URL,
  MOTIONPR_INSTALL_SPEC,
  MOTIONPR_PACKAGE,
  MOTIONPR_REPOSITORY,
  MOTIONPR_VERSION,
  distTagFor,
} from "./version.ts";

// Errors
export {
  ConfigError,
  MotionprError,
  SchemaError,
  formatIssuePath,
  isMotionprError,
  type ConfigIssue,
  type MotionprErrorCode,
} from "./errors.ts";

// Browsers
export * from "./browsers.ts";

// Configuration
export * from "./config/schema.ts";
export {
  defineConfig,
  defineScenario,
  defineSteps,
  type ConfigContext,
  type ConfigFactory,
} from "./config/define.ts";
export {
  configHash,
  deepMerge,
  effectiveBaseURL,
  joinUrl,
  resolveConfig,
  resolveViewports,
  scenarioUrl,
  scenarioViewports,
  stableStringify,
  webServers,
  type ResolveConfigOptions,
} from "./config/resolve.ts";

// Schemas
export * from "./schema/capture.ts";
export * from "./schema/comparison.ts";
export * from "./schema/report.ts";
export {
  CAPTURE_MIGRATIONS,
  COMPARISON_MIGRATIONS,
  parseCaptureBundle,
  parseComparisonResult,
} from "./schema/parse.ts";

// Values, easing, identity, timeline
export * from "./timeline.ts";
export * from "./values.ts";
export * from "./easing/index.ts";
export * from "./identity.ts";
export * from "./protocol.ts";
export * from "./adapter-contract.ts";

// Markdown summaries
export { captureMarkdown, comparisonMarkdown, mdEscape } from "./markdown.ts";

// Storage & privacy
export * from "./storage.ts";
export { contentId, sha256 } from "./hash.ts";
export { redactUrl, serializeJsonForHtml } from "./redact.ts";
export { isVersionRange, versionSatisfies } from "./semver.ts";
