import {
  BROWSER_LABELS,
  MotionprError,
  resolveConfig,
  type AdapterCheckResult,
} from "@motionpr/core";
import { checkAdapter, type AdapterCheckReport } from "@motionpr/capture";
import type { Terminal } from "../output/terminal.ts";
import {
  assertBrowsersInstalled,
  banner,
  cwdOf,
  makeTerminal,
  printJson,
  selectBrowsers,
  type GlobalOptions,
} from "./shared.ts";

export interface AdapterCheckCommandOptions extends GlobalOptions {
  adapter?: string;
  script?: string;
  /** `--browser`: engine names, comma lists or `all` (repeatable). */
  browser?: string[];
  headed?: boolean;
  timeout?: string;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return 10_000;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 500 || ms > 300_000)
    throw new MotionprError(
      "CONFIG_INVALID",
      `--timeout must be a whole number of ms between 500 and 300000; got "${value}".`,
    );
  return ms;
}

function printReport(t: Terminal, report: AdapterCheckReport): void {
  const a = report.adapter;
  t.write(
    `  ${t.c.bold(a?.name ?? "no adapter")}${a ? t.c.dim(`  protocol ${a.protocol ?? "unsupported"} · ${a.version ? `engine ${a.version}` : "no engine version"}${a.supportedRange ? ` (tested ${a.supportedRange})` : ""}`) : ""}`,
  );
  t.write(
    `  ${t.c.dim(`${BROWSER_LABELS[report.browser]} ${report.browserVersion} · ${report.page}`)}`,
  );
  t.write();
  const icon = (c: AdapterCheckResult) =>
    c.status === "pass"
      ? t.c.green(t.symbols.ok)
      : c.status === "fail"
        ? t.c.red(t.symbols.fail)
        : c.status === "warn"
          ? t.c.yellow(t.symbols.warn)
          : t.c.dim(t.symbols.bullet);
  const width = Math.max(...report.checks.map((c) => c.id.length));
  for (const c of report.checks) {
    const line = `  ${icon(c)} ${c.id.padEnd(width)}  ${c.status === "fail" ? c.summary : t.c.dim(c.summary)}`;
    if (c.status === "fail") t.writeAlways(line);
    else t.write(line);
    if (c.status === "fail" || c.status === "warn" || t.verbose)
      for (const d of c.details) t.hint(`  ${d}`);
  }
  t.write();
  const { fail, warn, pass, skip } = report.counts;
  const tally = `${pass} passed, ${warn} warning${warn === 1 ? "" : "s"}, ${skip} skipped`;
  if (report.passed)
    t.success(`Conforms to adapter protocol 2 in ${BROWSER_LABELS[report.browser]} (${tally}).`);
  else
    t.fail(
      `${fail} check${fail === 1 ? "" : "s"} failed in ${BROWSER_LABELS[report.browser]} (${tally}).`,
    );
}

/** `motionpr adapter check <page>`: the adapter conformance suite. Exit 1 when a check fails. */
export async function adapterCheckCommand(
  options: AdapterCheckCommandOptions,
  args: string[],
): Promise<number> {
  const t = makeTerminal(options);
  const page = args[0];
  if (!page)
    throw new MotionprError("CONFIG_INVALID", "Pass the page to check: a URL or an HTML file.");
  banner(t, "adapter check");
  const browsers = selectBrowsers(options.browser, "chromium");
  const timeout = parseTimeout(options.timeout);
  const headless = !options.headed;
  assertBrowsersInstalled(
    browsers,
    resolveConfig({ baseURL: "http://localhost", scenarios: [{ id: "adapter-check" }] }),
    headless,
  );
  const reports: AdapterCheckReport[] = [];
  for (const browserName of browsers) {
    const spinner = t.json ? null : t.spinner(`Checking in ${BROWSER_LABELS[browserName]}…`);
    let report: AdapterCheckReport;
    try {
      report = await checkAdapter({
        page,
        browserName,
        headless,
        timeout,
        cwd: cwdOf(options),
        ...(options.adapter ? { adapter: options.adapter } : {}),
        ...(options.script ? { script: options.script } : {}),
      });
    } finally {
      spinner?.stop();
    }
    reports.push(report);
    if (!t.json) {
      if (reports.length > 1) t.rule();
      printReport(t, report);
    }
  }
  const passed = reports.every((r) => r.passed);
  if (t.json) printJson(reports.length === 1 ? reports[0] : { passed, reports });
  return passed ? 0 : 1;
}
