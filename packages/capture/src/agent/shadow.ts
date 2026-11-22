/**
 * Shadow roots the agent can see, and the selectors that reach into them.
 *
 * `document.getAnimations()` leaves shadow trees out, and events that are not composed
 * (`scroll`, `transitionrun`, `animationstart`) stop at the shadow root they were dispatched in,
 * so the agent keeps every shadow root it learns of and asks each one directly:
 *
 * - roots attached by script: `attachShadow` is wrapped before any page script runs, so this
 *   includes closed roots (the agent keeps the reference `attachShadow` returned);
 * - declarative open roots (`<template shadowrootmode="open">`), which the parser creates without
 *   `attachShadow`: found by `forEachElement()` through `element.shadowRoot`.
 *
 * Declarative closed roots are invisible to page scripts, and so to MotionPR. Roots are held
 * weakly; a root whose host is not in the document is skipped.
 */

export interface ShadowRegistry {
  /** Known shadow roots whose host is in the document, nested roots included. */
  roots(): ShadowRoot[];
  /**
   * Calls `visit` for every element of the document and of every known shadow root (nested ones
   * included), registering the open shadow roots it passes.
   */
  forEachElement(visit: (el: Element) => void): void;
  /** Registers declarative open shadow roots that are not known yet. */
  discover(): void;
  /** First element matching a MotionPR selector (see `splitSelector`), or null. */
  query(selector: string): Element | null;
}

/** True for a shadow root (a document fragment with a host), false for documents and elements. */
export function isShadowRoot(node: Node | null | undefined): node is ShadowRoot {
  return !!node && node.nodeType === 11 && "host" in node && !!(node as ShadowRoot).host;
}

/** The shadow root an element is in, or null when it is in the document (or detached). */
export function shadowRootOf(el: Element): ShadowRoot | null {
  const root = el.getRootNode();
  return isShadowRoot(root) ? root : null;
}

/**
 * Whether the element or one of its ancestors matches `selector`, also above the shadow roots it
 * is in: the hosts and their ancestors count (an ignored widget ignores its shadow contents).
 */
export function closestComposed(el: Element, selector: string): boolean {
  for (let node: Element | null = el; node; node = shadowRootOf(node)?.host ?? null) {
    if (node.closest(selector)) return true;
  }
  return false;
}

/**
 * Splits a selector at Playwright's chaining operator `>>` (outside quotes, brackets and
 * parentheses) into CSS selectors, dropping an optional `css=` prefix. Returns null for parts in
 * other Playwright selector engines (`text=`, `role=`, `xpath=`, …), which only Playwright
 * resolves, and for empty parts.
 */
export function splitSelector(selector: string): string[] | null {
  const parts: string[] = [];
  let quote: string | null = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "(") depth++;
    else if ((c === "]" || c === ")") && depth > 0) depth--;
    else if (c === ">" && selector[i + 1] === ">" && depth === 0) {
      parts.push(selector.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  parts.push(selector.slice(start));
  const out: string[] = [];
  for (const raw of parts) {
    let part = raw.trim();
    if (part.startsWith("css=")) part = part.slice(4).trim();
    else if (/^[a-z][\w-]*=/i.test(part)) return null;
    if (!part) return null;
    out.push(part);
  }
  return out;
}

/**
 * A selector part searched inside a host's shadow tree. Playwright treats the elements at the
 * top of a shadow tree as children of `:scope` (the previous match, the host); in the shadow
 * tree's own selector context that element is `:host`.
 */
function forShadowTree(part: string): string {
  return part.replace(/^:scope(?=[\s>+~]|$)/, ":host");
}

function queryAll(scope: ParentNode, selector: string): Element[] {
  try {
    return Array.from(scope.querySelectorAll(selector));
  } catch {
    return [];
  }
}

/**
 * Starts tracking shadow roots. `onRoot` is called once for every root as it becomes known (to
 * listen for the events that do not leave it).
 */
export function createShadowRegistry(
  win: Window & typeof globalThis,
  onRoot: (root: ShadowRoot) => void,
): ShadowRegistry {
  const doc = win.document;
  const refs: WeakRef<ShadowRoot>[] = [];
  const known = new WeakSet<ShadowRoot>();
  /** Host → its shadow root, for closed roots too (`host.shadowRoot` is null for those). */
  const byHost = new WeakMap<Element, ShadowRoot>();

  function register(root: ShadowRoot): void {
    if (known.has(root)) return;
    known.add(root);
    refs.push(new WeakRef(root));
    byHost.set(root.host, root);
    try {
      onRoot(root);
    } catch {
      // observing a root must never break the page
    }
  }

  const nativeAttachShadow = win.Element.prototype.attachShadow;
  if (typeof nativeAttachShadow === "function") {
    win.Element.prototype.attachShadow = function patchedAttachShadow(
      this: Element,
      init: ShadowRootInit,
    ): ShadowRoot {
      const root = nativeAttachShadow.call(this, init);
      register(root);
      return root;
    };
  }

  function roots(): ShadowRoot[] {
    const out: ShadowRoot[] = [];
    let live = 0;
    for (let i = 0; i < refs.length; i++) {
      const root = refs[i]!.deref();
      if (!root) continue;
      refs[live++] = refs[i]!;
      if (root.host.isConnected) out.push(root);
    }
    refs.length = live;
    return out;
  }

  function forEachElement(visit: (el: Element) => void): void {
    const scopes: (Document | ShadowRoot)[] = [doc, ...roots()];
    const queued = new Set<Document | ShadowRoot>(scopes);
    for (let s = 0; s < scopes.length; s++) {
      const scope = scopes[s]!;
      const all = scope === doc ? doc.getElementsByTagName("*") : scope.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const el = all[i]!;
        const open = el.shadowRoot;
        if (open && !queued.has(open)) {
          register(open);
          queued.add(open);
          scopes.push(open);
        }
        visit(el);
      }
    }
  }

  /** The shadow root of a host: its open root, or a closed one attached after the agent. */
  function rootOf(host: Element): ShadowRoot | null {
    return host.shadowRoot ?? byHost.get(host) ?? null;
  }

  /**
   * MotionPR selectors are CSS selectors chained with `>>`, as in Playwright: the first part is
   * matched in the document, and each further part inside the previous match, first in its
   * shadow tree (a leading `:scope` stands for the host there), then among its descendants.
   */
  function query(selector: string): Element | null {
    const parts = splitSelector(selector);
    if (!parts) return null;
    let matches = queryAll(doc, parts[0]!);
    for (let p = 1; p < parts.length && matches.length; p++) {
      const next: Element[] = [];
      for (const host of matches) {
        const root = rootOf(host);
        if (root) next.push(...queryAll(root, forShadowTree(parts[p]!)));
        next.push(...queryAll(host, parts[p]!));
      }
      matches = next;
    }
    return matches[0] ?? null;
  }

  return { roots, forEachElement, discover: () => forEachElement(() => undefined), query };
}
