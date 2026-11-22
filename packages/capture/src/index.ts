export { AGENT_SOURCE } from "./agent/agent-bundle.generated.ts";
export { checkAdapter, type AdapterCheckOptions, type AdapterCheckReport } from "./conformance.ts";
export {
  browserNameOf,
  browserType,
  expectedBrowserPath,
  expectedChromiumPath,
  installBrowsers,
  isBrowserInstalled,
  isMissingDependencies,
  isMissingExecutable,
  launchBrowser,
  launchOptionsFor,
  playwrightVersion,
  type InstallOptions,
} from "./browser.ts";
export {
  correlateMotion,
  normalizeAnimations,
  normalizeScroll,
  normalizeTimelines,
  scrollMovement,
  timelineIds,
} from "./normalize.ts";
export {
  INPUT_MASK_SELECTOR,
  describeStep,
  frameTimes,
  pngSize,
  projectName,
  runCapture,
  selectScenarios,
  type CaptureEvent,
  type CaptureOptions,
  type CaptureOutcome,
} from "./runner.ts";
export {
  isUrlReady,
  startWebServers,
  type WebServerHandle,
  type WebServerLogger,
} from "./web-server.ts";
