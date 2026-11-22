/**
 * Typed errors. Every error MotionPR raises on purpose extends {@link MotionprError} and carries a
 * stable `code` plus an optional actionable `hint`. The CLI maps all of them to exit code 2.
 */
export type MotionprErrorCode =
  | "CONFIG_NOT_FOUND"
  | "CONFIG_INVALID"
  | "CONFIG_LOAD_FAILED"
  | "SCHEMA_INVALID"
  | "SCHEMA_UNSUPPORTED_VERSION"
  | "CAPTURE_NOT_FOUND"
  | "BASELINE_NOT_FOUND"
  | "BASELINE_EXISTS"
  | "BROWSER_NOT_INSTALLED"
  | "BROWSER_DEPENDENCIES_MISSING"
  | "BROWSER_LAUNCH_FAILED"
  | "BROWSER_MISMATCH"
  | "WEB_SERVER_FAILED"
  | "WEB_SERVER_TIMEOUT"
  | "SCENARIO_NOT_FOUND"
  | "CAPTURE_FAILED"
  | "REPORT_NOT_FOUND"
  | "REPORT_FAILED"
  | "FILE_EXISTS"
  | "ADAPTER_CHECK_FAILED"
  | "ABORTED"
  | "INTERNAL";

export class MotionprError extends Error {
  override name = "MotionprError";
  readonly code: MotionprErrorCode;
  readonly hint: string | undefined;

  constructor(
    code: MotionprErrorCode,
    message: string,
    options: { hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.hint = options.hint;
  }
}

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigError extends MotionprError {
  override name = "ConfigError";
  readonly file: string | undefined;
  readonly issues: ConfigIssue[];

  constructor(
    code: Extract<MotionprErrorCode, "CONFIG_NOT_FOUND" | "CONFIG_INVALID" | "CONFIG_LOAD_FAILED">,
    message: string,
    options: { file?: string; issues?: ConfigIssue[]; hint?: string; cause?: unknown } = {},
  ) {
    super(code, message, options);
    this.file = options.file;
    this.issues = options.issues ?? [];
  }
}

export class SchemaError extends MotionprError {
  override name = "SchemaError";
  readonly source: string | undefined;
  readonly issues: ConfigIssue[];

  constructor(
    code: Extract<MotionprErrorCode, "SCHEMA_INVALID" | "SCHEMA_UNSUPPORTED_VERSION">,
    message: string,
    options: { source?: string; issues?: ConfigIssue[]; hint?: string } = {},
  ) {
    super(code, message, options);
    this.source = options.source;
    this.issues = options.issues ?? [];
  }
}

export function isMotionprError(error: unknown): error is MotionprError {
  return error instanceof MotionprError;
}

/** Formats a zod-style issue path (`["scenarios", 0, "steps", 2, "selector"]`) as `scenarios[0].steps[2].selector`. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out ? `.${String(segment)}` : String(segment);
  }
  return out || "(root)";
}
