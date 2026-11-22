import { Command, Option } from "commander";
import {
  ConfigError,
  MOTIONPR_VERSION,
  SchemaError,
  isMotionprError,
  MOTIONPR_DOCS_URL,
  MOTIONPR_INSTALL_SPEC,
  MOTIONPR_REPOSITORY,
} from "@motionpr/core";
import { adapterCheckCommand } from "./commands/adapter.ts";
import {
  baselineAcceptCommand,
  baselineMigrateCommand,
  baselineStatusCommand,
} from "./commands/baseline.ts";
import { captureCommand } from "./commands/capture.ts";
import { compareCommand } from "./commands/compare.ts";
import { demoCommand } from "./commands/demo.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { initCommand } from "./commands/init.ts";
import { installCommand } from "./commands/install.ts";
import { reportCommand } from "./commands/report.ts";
import { runCommand } from "./commands/run.ts";
import { makeTerminal, type GlobalOptions } from "./commands/shared.ts";
import { installSignalHandlers, runCleanups } from "./runtime/signals.ts";

const collect = (value: string, previous: string[] = []) => [...previous, value];

type Handler<O> = (options: O, args: string[]) => Promise<number>;

const BROWSER_HELP =
  "browser engine: chromium, firefox, webkit, or all (repeatable; comma lists work; default: config browser.name or MOTIONPR_BROWSER)";

/** Prints an error the way MotionPR reports problems: message, details, actionable hint. */
export function reportError(error: unknown, options: GlobalOptions): void {
  const t = makeTerminal({ ...options, quiet: false });
  if (options.json) {
    const payload = isMotionprError(error)
      ? {
          error: {
            code: error.code,
            message: error.message,
            hint: error.hint,
            issues:
              error instanceof ConfigError || error instanceof SchemaError
                ? error.issues
                : undefined,
          },
        }
      : {
          error: {
            code: "INTERNAL",
            message: error instanceof Error ? error.message : String(error),
          },
        };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  t.writeAlways();
  if (isMotionprError(error)) {
    t.fail(error.message);
    if (error instanceof ConfigError || error instanceof SchemaError) {
      for (const issue of error.issues.slice(0, 12))
        t.writeAlways(`      ${t.c.yellow(issue.path)}  ${issue.message}`);
      if (error.issues.length > 12)
        t.writeAlways(`      ${t.c.dim(`…${error.issues.length - 12} more`)}`);
    }
    if (error.hint)
      for (const line of error.hint.split("\n")) t.writeAlways(`    ${t.c.dim(line)}`);
    if (options.verbose && error.cause instanceof Error)
      t.writeAlways(t.c.dim(String(error.cause.stack)));
  } else {
    t.fail(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error && error.stack)
      t.writeAlways(
        t.c.dim(options.verbose ? error.stack : error.stack.split("\n").slice(1, 4).join("\n")),
      );
    t.writeAlways(
      `    ${t.c.dim(`Please report this at ${MOTIONPR_REPOSITORY}/issues with the output of \`npx motionpr doctor\`.`)}`,
    );
  }
}

function action<O extends GlobalOptions>(handler: Handler<O>) {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const options = command.optsWithGlobals<O>();
    const positional = (args.slice(0, -2).flat() as unknown[]).filter(
      (a): a is string => typeof a === "string",
    );
    installSignalHandlers(() => {
      makeTerminal(options).writeAlways(
        "\n  Interrupted: cleaning up (press Ctrl+C again to force quit)…",
      );
    });
    let code: number;
    try {
      code = await handler(options, positional);
    } catch (error) {
      reportError(error, options);
      code = 2;
    } finally {
      await runCleanups();
    }
    process.exitCode = code;
    // Watchdog: if a stray handle keeps the event loop alive after we are done, exit anyway.
    setTimeout(() => process.exit(code), 3000).unref();
  };
}

export function createProgram(): Command {
  const program = new Command("motionpr");
  program
    .description("Capture, compare and inspect interface animations across versions.")
    .version(MOTIONPR_VERSION, "-v, --version")
    .option("-c, --config <path>", "path to motionpr.config.ts")
    .option("--cwd <dir>", "run as if started in <dir>")
    .option("--env <name>", "apply an environment from config.environments (also MOTIONPR_ENV)")
    .option("--json", "machine-readable output on stdout")
    .option("-q, --quiet", "only print errors")
    .option("--verbose", "print diagnostics and debug details")
    .option("--no-color", "disable colors (also NO_COLOR)")
    .option("--ci", "non-interactive CI mode (auto-detected from CI env vars)")
    .showHelpAfterError("(run with --help for usage)")
    .addHelpText(
      "after",
      `
Exit codes:
  0  comparison within configured thresholds (or command succeeded)
  1  a configured regression threshold was exceeded
  2  configuration, execution or comparison error

Quick start:
  $ npx motionpr init
  $ npx motionpr install
  $ npx motionpr run
  $ npx motionpr baseline accept

Browsers:
  Chromium (default), Firefox and WebKit, each with its own baseline, captures and report.
  $ npx motionpr install firefox webkit
  $ npx motionpr run --browser firefox
  $ npx motionpr run --browser all

Install: npm install -D ${MOTIONPR_INSTALL_SPEC}
Docs:    ${MOTIONPR_DOCS_URL}`,
    );

  program
    .command("init")
    .description("create motionpr.config.ts with a guided setup")
    .option("-y, --yes", "accept detected defaults without prompting")
    .option("--force", "replace an existing config")
    .option("--base-url <url>", "URL of the app under test")
    .option("--command <cmd>", "command that starts the app")
    .option("--no-command", "do not configure a web server")
    .option("--github", "also create .github/workflows/motionpr.yml")
    .option("--no-example", "do not add an example scenario")
    .action(action(initCommand));

  program
    .command("install")
    .argument("[browsers...]", "chromium, firefox, webkit (default: config browser.name)")
    .description(
      "download the browser builds MotionPR uses (Playwright's Chromium, Firefox, WebKit)",
    )
    .option("--all", "install Chromium, Firefox and WebKit")
    .option("--with-deps", "also install system dependencies (Linux, needs root)")
    .option("--only-shell", "Chromium: install only the headless shell (smaller; no --headed)")
    .option("--force", "reinstall even if present")
    .option("--dry-run", "print what would be installed")
    .action(action((options, names) => installCommand(names, options)));

  const captureOptions = (cmd: Command) =>
    cmd
      .option(
        "-s, --scenario <id>",
        "only run matching scenario ids (repeatable, supports * globs)",
        collect,
      )
      .option("--viewport <name>", "only run these viewports (repeatable)", collect)
      .option("--project <name>", "alias of --viewport", collect)
      .option("--browser <name>", BROWSER_HELP, collect)
      .option("--headed", "show the browser window")
      .option("--debug", "headed, with verbose capture details")
      .option("--no-web-server", "do not start configured web servers");

  captureOptions(
    program
      .command("capture")
      .description("capture configured scenarios")
      .option(
        "-o, --output <dir>",
        "write the capture to <dir> instead of .motionpr/captures/<id>",
      ),
  ).action(action(captureCommand));

  program
    .command("compare")
    .description("compare two captures and generate the report")
    .option(
      "-b, --baseline <capture>",
      "baseline: 'baseline' (default), a capture id or a directory",
    )
    .option("--current <capture>", "candidate: 'latest' (default), a capture id or a directory")
    .option("-o, --output <dir>", "directory for comparison.json and diff images")
    .option("-t, --threshold <severity>", "fail on: critical | warning | info | never")
    .addOption(
      new Option("-f, --format <format>", "summary format").choices(["text", "json", "markdown"]),
    )
    .option("--browser <name>", BROWSER_HELP, collect)
    .option(
      "--against <browser>",
      "compare with another browser's baseline (cross-browser; engine differences are uncertain)",
    )
    .option("--cross-browser", "allow --baseline and --current captures from different browsers")
    .option("--no-report", "skip HTML report generation")
    .option("--open", "open the report afterwards")
    .action(action(compareCommand));

  captureOptions(
    program
      .command("run")
      .description("capture, compare with the baseline, report — the everyday command")
      .option("-t, --threshold <severity>", "fail on: critical | warning | info | never")
      .option("--open", "open the report afterwards")
      .option("--allow-missing-baseline", "exit 0 in CI when no baseline exists yet")
      .option("--no-summary", "do not write $GITHUB_STEP_SUMMARY"),
  ).action(action(runCommand));

  const baseline = program
    .command("baseline")
    .description("manage the approved baselines (one per browser)");
  baseline
    .command("accept")
    .description("approve a capture (default: the latest) as its browser's new baseline")
    .option(
      "--from <capture>",
      "capture to approve: 'latest', an id, or a directory (e.g. a CI artifact)",
    )
    .option("--browser <name>", BROWSER_HELP, collect)
    .option("-y, --yes", "confirm replacing an existing baseline")
    .option("--allow-failed", "approve even if some scenarios failed")
    .action(action(baselineAcceptCommand));
  baseline
    .command("status")
    .description("show the baseline of every browser")
    .action(action(baselineStatusCommand));
  baseline
    .command("migrate")
    .description("move a 0.1 baseline (baseline/capture.json) into baseline/<browser>/")
    .action(action(baselineMigrateCommand));

  program
    .command("report")
    .description("open the most recent report (regenerating it if needed)")
    .option("--open", "open in the browser (default when interactive)")
    .option("--no-open", "only print the path")
    .option("--regenerate", "rebuild the report from the latest capture and comparison")
    .option("--browser <name>", "open this browser's report (default: the index of all)", collect)
    .action(action(reportCommand));

  program
    .command("doctor")
    .description("check Node, browsers, config, permissions and common issues")
    .option("--browser <name>", "browsers to launch-check (default: config browser.name)", collect)
    .option("--no-launch", "skip the browser launch check")
    .action(action(doctorCommand));

  const adapter = program
    .command("adapter")
    .description("check animation-engine adapters against the adapter protocol");
  adapter
    .command("check")
    .argument(
      "<page>",
      "URL or HTML file of a page that uses the adapter and starts motion on load",
    )
    .description("run the adapter conformance suite (adapter protocol 2) in a real browser")
    .option("--adapter <name>", "adapter to check (default: the only one the page registers)")
    .option("--script <file>", "script that registers the adapter, injected before page scripts")
    .option("--browser <name>", "chromium (default), firefox, webkit, or all (repeatable)", collect)
    .option(
      "--timeout <ms>",
      "wait this long for registration, motion and settling (default 10000)",
    )
    .option("--headed", "show the browser window")
    .action(action(adapterCheckCommand));

  program
    .command("demo")
    .description("capture the bundled demo app in two versions and open a real report")
    .option("-o, --output <dir>", "where to write the demo output (default: system temp dir)")
    .option("-s, --scenario <id>", "only run matching demo scenarios", collect)
    .option("--browser <name>", "chromium (default), firefox or webkit", collect)
    .option("--open", "open the report (default when interactive)")
    .option("--no-open", "do not open the report")
    .action(action(demoCommand));

  return program;
}

/**
 * Applies MotionPR's exit-code contract to Commander's own exits on every (sub)command:
 * --help / --version exit 0; usage errors (unknown options, missing arguments) exit 2, never 1,
 * because 1 means "regression found". Commander does not propagate exitOverride() to
 * subcommands created before the call, so it is applied to the whole tree.
 */
export function applyExitCodes(
  command: Command,
  exit: (code: number) => never = process.exit,
): void {
  command.exitOverride((error) => {
    const code =
      error.code === "commander.helpDisplayed" ||
      error.code === "commander.version" ||
      error.code === "commander.help"
        ? 0
        : 2;
    exit(code);
  });
  for (const sub of command.commands) applyExitCodes(sub, exit);
}

export async function main(argv = process.argv): Promise<void> {
  const program = createProgram();
  applyExitCodes(program);
  await program.parseAsync(argv);
}
