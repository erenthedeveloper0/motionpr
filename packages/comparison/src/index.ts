export {
  compareCaptures,
  exitCodeFor,
  ENGINE_DEPENDENT_CHANGES,
  type CompareOptions,
} from "./compare.ts";
export { compareMatchedAnimation, easingChange } from "./diff-animation.ts";
export {
  matchAnimations,
  type AnimationMatch,
  type MatchOptions,
  type MatchResult,
} from "./match.ts";
export {
  DEFAULT_RULE_SEVERITY,
  applyOverride,
  magnitudeSeverity,
  timingSeverity,
} from "./severity.ts";
export { compareStagger, staggerGroupKey, staggerIntervals } from "./stagger.ts";
export {
  PngCache,
  compareScreenshots,
  diffImages,
  frameDivergence,
  type ImageSource,
} from "./visual.ts";
export {
  compareScrollRecords,
  matchScroll,
  scrollMetrics,
  unevenDelivery,
  CURVE_POINTS,
} from "./scroll.ts";
export { compareTimelineRecords } from "./timelines.ts";
