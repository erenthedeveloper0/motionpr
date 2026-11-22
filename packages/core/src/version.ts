/**
 * MotionPR version. Kept in sync with packages/cli/package.json by scripts/sync-version.mjs
 * and verified by a unit test.
 */
export const MOTIONPR_VERSION = "0.5.0-alpha";

/** npm name of the public package (packages/cli/package.json `name`; verified by a unit test). */
export const MOTIONPR_PACKAGE = "@erenthedeveloper0/motionpr";
/** Source repository. */
export const MOTIONPR_REPOSITORY = "https://github.com/erenthedeveloper0/motionpr";
/** Documentation website (GitHub Pages). */
export const MOTIONPR_DOCS_URL = "https://erenthedeveloper0.github.io/motionpr/";

/**
 * npm dist-tag a version is published under: prereleases never go to `latest`,
 * so `npm install @erenthedeveloper0/motionpr` cannot pick one up by accident.
 */
export function distTagFor(version: string): "alpha" | "beta" | "next" | "latest" {
  if (/-alpha(?:\.|$)/.test(version)) return "alpha";
  if (/-beta(?:\.|$)/.test(version)) return "beta";
  if (/-rc(?:\.|$)/.test(version)) return "next";
  return "latest";
}

/** What to install: the package, pinned to the dist-tag of this version when it is a prerelease. */
export const MOTIONPR_INSTALL_SPEC =
  distTagFor(MOTIONPR_VERSION) === "latest"
    ? MOTIONPR_PACKAGE
    : `${MOTIONPR_PACKAGE}@${distTagFor(MOTIONPR_VERSION)}`;
