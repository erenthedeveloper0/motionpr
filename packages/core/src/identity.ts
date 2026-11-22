/**
 * Pure helpers for element identification. They are shared by the in-page agent (bundled into
 * the browser) and Node-side code, so this module must not import anything with side effects.
 */

export type IdentityMethod = "motionpr-id" | "test-id" | "dom-id" | "aria" | "dom-path" | "adapter";
export type IdentityConfidence = "high" | "medium" | "low";

/** Order of preference for identifying an element across captures. */
export const IDENTITY_METHOD_ORDER: readonly IdentityMethod[] = [
  "motionpr-id",
  "test-id",
  "dom-id",
  "aria",
  "dom-path",
];

export const METHOD_CONFIDENCE: Record<IdentityMethod, IdentityConfidence> = {
  "motionpr-id": "high",
  "test-id": "high",
  "dom-id": "medium",
  aria: "medium",
  "dom-path": "low",
  // Non-DOM targets: as reliable as the key the adapter derives (a name scores medium).
  adapter: "medium",
};

/**
 * Heuristic for DOM ids that are generated at runtime and therefore unstable between builds:
 * React `useId` (`:r1:` / `«r1»`), Radix/Headless UI (`radix-:r2:`, `headlessui-menu-3`),
 * Ember (`ember123`), long hex/hash fragments and ids that are mostly digits.
 */
export function isLikelyGeneratedId(id: string): boolean {
  if (!id || id.length > 64) return true;
  if (/^[:«].*[:»]$/.test(id) || /[:«»]r[0-9a-z]+[:«»]/i.test(id)) return true;
  if (
    /^(ember|ext-gen|yui_|gwt-uid-|mui-|headlessui-|radix-|react-aria|rc-|ng-|cdk-|mat-)/i.test(id)
  )
    return true;
  if (/[0-9a-f]{8,}/i.test(id)) return true;
  const digits = id.replace(/\D/g, "").length;
  if (digits >= 4 && digits / id.length > 0.4) return true;
  return false;
}

/**
 * Joins a shadow host's identity and the identity of an element inside its shadow root, in keys
 * (`test-id:plan-pro >> motionpr-id:glow`) and selectors (Playwright's chaining operator).
 */
export const SHADOW_SEPARATOR = " >> ";

/**
 * The part of an element key below its innermost shadow host (`motionpr-id:glow` for
 * `test-id:plan-pro >> motionpr-id:glow`); the whole key for elements outside shadow roots.
 */
export function keyInShadowRoot(identity: { key: string; shadowHost?: string }): string {
  const host = identity.shadowHost;
  if (!host) return identity.key;
  const prefix = host + SHADOW_SEPARATOR;
  return identity.key.startsWith(prefix) ? identity.key.slice(prefix.length) : identity.key;
}

/** Collapses whitespace, strips control characters and truncates user-visible labels. */
export function sanitizeLabel(value: string | null | undefined, max = 60): string | undefined {
  if (!value) return undefined;
  const clean = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Escapes a value for use inside a double-quoted CSS attribute selector. */
export function cssAttrValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ");
}

/** Builds a stable animation key from its element key, type and name. */
export function animationKey(
  elementKey: string,
  type: string,
  name: string | null | undefined,
): string {
  return `${elementKey}::${type}::${name ?? "anonymous"}`;
}
