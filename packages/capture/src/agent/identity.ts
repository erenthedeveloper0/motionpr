import {
  SHADOW_SEPARATOR,
  cssAttrValue,
  isLikelyGeneratedId,
  sanitizeLabel,
} from "@motionpr/core/identity";
import type { RawElementIdentity } from "@motionpr/core/protocol";
import { shadowRootOf } from "./shadow.ts";

export interface IdentityOptions {
  motionprIdAttribute: string;
  testIdAttribute: string;
}

interface Strong {
  key: string;
  selector: string;
  method: RawElementIdentity["method"];
}

/**
 * Where an element's identity is unique: the document, or the shadow root it is in (ids and
 * selectors are scoped to one tree, and a component's template repeats in every instance).
 */
type Scope = Document | ShadowRoot;

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function isUnique(selector: string, scope: Scope): boolean {
  try {
    return scope.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/** High/medium confidence identity of an element, or null when it has none. */
function strongIdentity(el: Element, options: IdentityOptions, scope: Scope): Strong | null {
  const mid = el.getAttribute(options.motionprIdAttribute);
  if (mid) {
    return {
      key: `motionpr-id:${mid}`,
      selector: `[${options.motionprIdAttribute}="${cssAttrValue(mid)}"]`,
      method: "motionpr-id",
    };
  }
  const tid = el.getAttribute(options.testIdAttribute);
  if (tid) {
    return {
      key: `test-id:${tid}`,
      selector: `[${options.testIdAttribute}="${cssAttrValue(tid)}"]`,
      method: "test-id",
    };
  }
  const id = el.id;
  if (id && !isLikelyGeneratedId(id) && isUnique(`#${cssEscape(id)}`, scope)) {
    return { key: `id:${id}`, selector: `#${cssEscape(id)}`, method: "dom-id" };
  }
  return null;
}

/** Accessible-name based identity for interactive elements with a unique label. */
function ariaIdentity(el: Element, scope: Scope): Strong | null {
  const tag = el.tagName.toLowerCase();
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) {
    const selector = `${tag}[aria-label="${cssAttrValue(ariaLabel)}"]`;
    if (isUnique(selector, scope))
      return { key: `aria:${tag}[${ariaLabel}]`, selector, method: "aria" };
  }
  const role = el.getAttribute("role");
  if (
    (tag === "button" ||
      tag === "a" ||
      role === "button" ||
      role === "tab" ||
      role === "menuitem") &&
    !el.children.length
  ) {
    const text = sanitizeLabel(el.textContent, 40);
    if (text) {
      const sameTag = Array.from(
        scope.querySelectorAll(role ? `${tag}[role="${cssAttrValue(role)}"]` : tag),
      );
      const matches = sameTag.filter((other) => sanitizeLabel(other.textContent, 40) === text);
      if (matches.length === 1) {
        // :nth-of-type keeps the selector usable with querySelector; the key stays text-based.
        return {
          key: `aria:${role ?? tag}[${text}]`,
          selector: domPath(el, null, scope).selector,
          method: "aria",
        };
      }
    }
  }
  return null;
}

function segment(el: Element): string {
  const tag = el.tagName.toLowerCase();
  // At the top of a shadow tree the parent node is the shadow root, not an element.
  const parent = el.parentElement ?? (shadowRootOf(el) === el.parentNode ? el.parentNode : null);
  if (!parent) return tag;
  const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  return siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(el) + 1})` : tag;
}

/**
 * Path from the nearest strongly identified ancestor down to the element. Without one, the path
 * starts at <body>, or at the top of the shadow tree the element is in (`#shadow-root`, whose
 * selector starts at `:scope`, the host, as in Playwright).
 */
function domPath(
  el: Element,
  anchor: { el: Element; strong: Strong } | null,
  scope: Scope,
): { key: string; selector: string } {
  const parts: string[] = [];
  let current: Element | null = el;
  const inShadow = scope !== document;
  const stop = anchor?.el ?? (inShadow ? null : document.body);
  while (current && current !== stop && current !== document.documentElement) {
    parts.unshift(segment(current));
    current = current.parentElement;
  }
  const chain = parts.join(">");
  if (anchor) {
    return {
      key: `path:${anchor.strong.key}>${chain}`,
      selector: `${anchor.strong.selector} > ${parts.join(" > ")}`,
    };
  }
  if (inShadow)
    return { key: `path:#shadow-root>${chain}`, selector: `:scope > ${parts.join(" > ")}` };
  return { key: `path:body>${chain}`, selector: `body > ${parts.join(" > ")}` };
}

function labelOf(el: Element): string | undefined {
  const tag = el.tagName.toLowerCase();
  const explicit =
    el.getAttribute("aria-label") ?? el.getAttribute("alt") ?? el.getAttribute("title");
  if (explicit) return sanitizeLabel(explicit, 48);
  // Never read text from form controls: their content may be user input.
  if (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    (el as HTMLElement).isContentEditable
  )
    return undefined;
  // innerText follows rendering (spaces between blocks); textContent would glue words together.
  const text = el instanceof HTMLElement ? el.innerText : el.textContent;
  return sanitizeLabel(text, 48);
}

/** Identity of an element within one tree: its document or its shadow root. */
function identifyInScope(
  el: Element,
  pseudoElement: string | null | undefined,
  options: IdentityOptions,
  scope: Scope,
): RawElementIdentity {
  const tag = el.tagName.toLowerCase();
  const suffix = pseudoElement ? pseudoElement : "";
  const base = { tag, label: labelOf(el), ...(pseudoElement ? { pseudoElement } : {}) };

  const strong = strongIdentity(el, options, scope);
  if (strong) {
    return {
      ...base,
      key: strong.key + suffix,
      selector: strong.selector,
      method: strong.method,
      confidence: strong.method === "dom-id" ? "medium" : "high",
      warnings: [],
    };
  }
  const aria = ariaIdentity(el, scope);
  if (aria) {
    return {
      ...base,
      key: aria.key + suffix,
      selector: aria.selector,
      method: "aria",
      confidence: "medium",
      warnings: ["Identified by accessible label; changing the label breaks matching."],
    };
  }

  let anchor: { el: Element; strong: Strong } | null = null;
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = strongIdentity(p, options, scope);
    if (s) {
      anchor = { el: p, strong: s };
      break;
    }
  }
  const path = domPath(el, anchor, scope);
  const from = scope === document ? "<body>" : "the top of its shadow root";
  return {
    ...base,
    key: path.key + suffix,
    selector: path.selector,
    method: "dom-path",
    confidence: "low",
    ...(anchor ? { anchor: anchor.strong.key } : {}),
    warnings: [
      anchor
        ? `Matched by DOM position under ${anchor.strong.key}. Add ${options.motionprIdAttribute} for a reliable match.`
        : `Matched by DOM position from ${from}. Add ${options.motionprIdAttribute} for a reliable match.`,
    ],
  };
}

const RANK = { high: 2, medium: 1, low: 0 } as const;

/**
 * Identifies an element for cross-capture matching, preferring explicit attributes:
 * data-motionpr-id → data-testid → stable unique id → accessible label → anchored DOM path.
 *
 * An element inside a shadow root is identified within that root (ids and uniqueness are per
 * tree, and a component's template repeats in each instance) and prefixed with the identity of
 * its host: `test-id:plan-pro >> motionpr-id:glow`, selector
 * `[data-testid="plan-pro"] >> [data-motionpr-id="glow"]` (Playwright's chaining syntax). It is
 * only as reliable as the less reliable of the two. `formerRoot` is the shadow root a detached
 * element was in (a re-rendered component replaced it while it animated).
 */
export function identifyElement(
  el: Element,
  pseudoElement: string | null | undefined,
  options: IdentityOptions,
  formerRoot: ShadowRoot | null = null,
): RawElementIdentity {
  const root = shadowRootOf(el) ?? (el.isConnected ? null : formerRoot);
  if (!root) return identifyInScope(el, pseudoElement, options, document);
  const host = identifyElement(root.host, null, options);
  const inner = identifyInScope(el, pseudoElement, options, root);
  const confidence =
    RANK[host.confidence] < RANK[inner.confidence] ? host.confidence : inner.confidence;
  return {
    ...inner,
    key: `${host.key}${SHADOW_SEPARATOR}${inner.key}`,
    selector: `${host.selector}${SHADOW_SEPARATOR}${inner.selector}`,
    confidence,
    shadowHost: host.key,
    warnings: [
      ...inner.warnings,
      ...(host.confidence === "low"
        ? [
            `Inside the shadow root of ${host.key}, which is matched by DOM position. Add ${options.motionprIdAttribute} to the host for a reliable match.`,
          ]
        : []),
    ],
  };
}
