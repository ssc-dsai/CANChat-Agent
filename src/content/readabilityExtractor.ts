// Readability-style main-content selection: prefer semantic containers, fall
// back to the densest text block, then the whole body.
//
// Both the candidate search and the text collection are *shadow-DOM aware*: they
// descend through open shadow roots (resolving <slot> projection) and same-origin
// iframes. This mirrors what the interactive element map already does
// (domExtractor.collectInteractive) and is what lets pages built on web
// components — new Reddit's `shreddit-*` elements, Salesforce Lightning, many
// design systems — actually be *read*, not just clicked. Plain textContent /
// innerText / querySelectorAll stop at every shadow boundary, so without this the
// agent gets only the light-DOM shell (nav chrome) and reports the page as empty.

const CANDIDATE_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '#content',
  '#main',
  '.post-content',
  '.article-body',
  '.content',
];

// Tags whose subtree is chrome/noise rather than content. Matched by tag name so
// the check works while walking live nodes (no cloning), including inside shadow
// roots where a selector-based removal pass wouldn't reach.
const NOISE_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'FOOTER', 'ASIDE', 'HEADER']);

// Block-level tags get a trailing newline so the collapsed output keeps sensible
// line breaks (textContent alone would run paragraphs together).
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'LI', 'UL', 'OL', 'TR', 'TABLE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'FIGURE',
  'HEADER', 'FOOTER', 'MAIN', 'ASIDE',
]);

function isNoise(el: Element): boolean {
  if (NOISE_TAGS.has(el.tagName)) return true;
  return el.getAttribute('aria-hidden') === 'true';
}

/**
 * `root` plus every open shadow root beneath it, found with ONE full-tree walk.
 * pickMainContent then runs each candidate selector against this cached list —
 * previously every selector re-scanned the whole DOM (`querySelectorAll('*')`)
 * just to rediscover the same shadow roots, an 8× repeat on large pages.
 */
function collectRoots(root: ParentNode): ParentNode[] {
  const roots: ParentNode[] = [root];
  for (let i = 0; i < roots.length; i++) {
    for (const el of Array.from(roots[i].querySelectorAll('*'))) {
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) roots.push(shadow);
    }
  }
  return roots;
}

function visibleTextLength(el: Element): number {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return 0;
  // Use the shadow-aware collector so a candidate whose body lives in a shadow
  // root isn't scored as empty (and thus skipped) here.
  return collectDeepText(el).replace(/\s+/g, ' ').trim().length;
}

export function pickMainContent(doc: Document): Element {
  const roots = collectRoots(doc);
  let best: Element | null = null;
  let bestLen = 0;
  for (const sel of CANDIDATE_SELECTORS) {
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll(sel))) {
        const len = visibleTextLength(el);
        if (len > bestLen) {
          best = el;
          bestLen = len;
        }
      }
    }
  }
  // Require a meaningful amount of text before trusting a candidate.
  if (best && bestLen > 200) return best;
  return doc.body;
}

// --- shadow/slot/iframe-flattening text collection ---------------------------

// Depth-first text walk that follows the *rendered* (flattened) tree:
//   - a shadow host is replaced by its open shadow root's content;
//   - a <slot> is replaced by its assigned (projected) light nodes, or its
//     default content when nothing is assigned;
//   - a same-origin <iframe> contributes its document body.
// This is the standard shadow-DOM flattening, so slotted light content is counted
// exactly once (never doubled, never dropped) rather than guessed at.
function walk(node: Node, out: string[]): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3 /* Text */) {
      const t = (child as Text).data;
      if (t) out.push(t);
      continue;
    }
    if (child.nodeType !== 1 /* Element */) continue;
    const el = child as Element;
    if (isNoise(el)) continue;

    if (el.tagName === 'BR') {
      out.push('\n');
      continue;
    }

    // <slot>: emit projected light DOM (flattened), or the slot's own default
    // content when nothing is assigned to it.
    if (typeof (el as HTMLSlotElement).assignedNodes === 'function') {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      if (assigned.length > 0) {
        for (const n of assigned) {
          if (n.nodeType === 3) {
            const t = (n as Text).data;
            if (t) out.push(t);
          } else if (n.nodeType === 1 && !isNoise(n as Element)) {
            walk(n, out);
          }
        }
        continue;
      }
      // No assignment — fall through to the slot's default children.
    }

    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) {
      // Rendered content comes from the shadow tree; light children only appear
      // through its <slot>s, which the recursion above handles.
      walk(shadow, out);
    } else if (el instanceof HTMLIFrameElement) {
      try {
        const body = el.contentDocument?.body;
        if (body) walk(body, out); // same-origin only; throws otherwise
      } catch {
        // Cross-origin iframe — unreachable without chrome.debugger.
      }
    } else {
      walk(el, out);
    }

    if (BLOCK_TAGS.has(el.tagName)) out.push('\n');
  }
}

/** Collect an element's text following the flattened (shadow/slot/iframe) tree. */
export function collectDeepText(el: Element): string {
  const parts: string[] = [];
  walk(el, parts);
  return parts.join('');
}

/** Extract readable text from an element, shadow-aware, with noise removed. */
export function readableText(el: Element): string {
  return collectDeepText(el)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, i, arr) => line.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join('\n')
    .trim();
}
