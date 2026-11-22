// The documentation's information architecture. Every page in /docs appears here exactly once
// (checked by scripts/tests/docs.test.ts), in reading order. `file` is relative to /docs.
export const NAV = [
  {
    title: "Overview",
    pages: [
      ["overview/introduction.md", "Introduction"],
      ["overview/why-motionpr.md", "Why MotionPR"],
      ["overview/how-it-works.md", "How it works"],
      ["overview/core-concepts.md", "Core concepts"],
    ],
  },
  {
    title: "Getting started",
    pages: [
      ["getting-started/requirements.md", "Requirements"],
      ["getting-started/installation.md", "Installation"],
      ["getting-started/browser-setup.md", "Browser setup"],
      ["getting-started/project-initialization.md", "Project initialization"],
      ["getting-started/first-capture.md", "First capture"],
      ["getting-started/first-comparison.md", "First comparison"],
      ["getting-started/first-report.md", "Your first report"],
    ],
  },
  {
    title: "Core features",
    pages: [
      ["features/animation-capture.md", "Animation capture"],
      ["features/interaction-scenarios.md", "Interaction scenarios"],
      ["features/animation-identification.md", "Animation identification"],
      ["features/capture-data-model.md", "Capture data model"],
      ["features/motion-comparison.md", "Motion comparison"],
      ["features/easing-analysis.md", "Easing analysis"],
      ["features/visual-comparison.md", "Visual comparison"],
      ["features/baselines.md", "Baselines"],
      ["features/severity.md", "Severity & thresholds"],
      ["features/html-reports.md", "HTML reports"],
    ],
  },
  {
    title: "Integrations",
    pages: [
      ["integrations/native-css.md", "Native CSS"],
      ["integrations/web-animations.md", "Web Animations API"],
      ["integrations/shadow-dom.md", "Shadow DOM"],
      ["integrations/gsap.md", "GSAP"],
      ["integrations/animejs.md", "Anime.js"],
      ["integrations/lenis.md", "Lenis"],
      ["integrations/combining-adapters.md", "Combining adapters"],
    ],
  },
  {
    title: "Browsers",
    pages: [
      ["browsers/support.md", "Browser support"],
      ["browsers/cross-browser-testing.md", "Cross-browser testing"],
      ["browsers/chromium.md", "Chromium"],
      ["browsers/firefox.md", "Firefox"],
      ["browsers/webkit.md", "WebKit"],
    ],
  },
  {
    title: "CLI",
    pages: [
      ["cli/overview.md", "Overview"],
      ["cli/init.md", "init"],
      ["cli/install.md", "install"],
      ["cli/capture.md", "capture"],
      ["cli/compare.md", "compare"],
      ["cli/run.md", "run"],
      ["cli/baseline.md", "baseline"],
      ["cli/report.md", "report"],
      ["cli/doctor.md", "doctor"],
      ["cli/demo.md", "demo"],
      ["cli/adapter.md", "adapter"],
    ],
  },
  {
    title: "Configuration",
    pages: [
      ["configuration/config-file.md", "Configuration file"],
      ["configuration/scenarios.md", "Scenarios"],
      ["configuration/viewports.md", "Viewports"],
      ["configuration/browser.md", "Browser settings"],
      ["configuration/web-server.md", "Web server"],
      ["configuration/sampling.md", "Sampling"],
      ["configuration/comparison.md", "Comparison thresholds"],
      ["configuration/ignore-rules.md", "Ignore rules"],
      ["configuration/privacy.md", "Privacy"],
      ["configuration/environment-variables.md", "Environment variables"],
    ],
  },
  {
    title: "CI/CD",
    pages: [
      ["ci/github-actions.md", "GitHub Actions"],
      ["ci/pull-request-workflow.md", "Pull request workflow"],
      ["ci/baseline-management.md", "Baseline management"],
      ["ci/report-artifacts.md", "Report artifacts"],
      ["ci/exit-codes.md", "Exit codes"],
      ["ci/security.md", "Security"],
    ],
  },
  {
    title: "Advanced",
    pages: [
      ["advanced/custom-adapters.md", "Custom adapters"],
      ["advanced/public-api.md", "Public API"],
      ["advanced/capture-serialization.md", "Capture serialization"],
      ["advanced/architecture.md", "Architecture"],
      ["advanced/performance.md", "Performance"],
      ["advanced/troubleshooting.md", "Troubleshooting"],
      ["advanced/limitations.md", "Limitations"],
      ["advanced/support-matrix.md", "Support matrix"],
    ],
  },
];

/** Flat list in reading order: { file, label, section, slug }. `slug` has no extension. */
export const PAGES = NAV.flatMap((section) =>
  section.pages.map(([file, label]) => ({
    file,
    label,
    section: section.title,
    slug: file.replace(/\.md$/, ""),
  })),
);
