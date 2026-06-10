// Readability-style main-content selection: prefer semantic containers, fall
// back to the densest text block, then the whole body.

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

const NOISE_SELECTORS = 'script, style, noscript, nav, footer, aside, header, [aria-hidden="true"]';

function visibleTextLength(el: Element): number {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return 0;
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

export function pickMainContent(doc: Document): Element {
  let best: Element | null = null;
  let bestLen = 0;
  for (const sel of CANDIDATE_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll(sel))) {
      const len = visibleTextLength(el);
      if (len > bestLen) {
        best = el;
        bestLen = len;
      }
    }
  }
  // Require a meaningful amount of text before trusting a candidate.
  if (best && bestLen > 200) return best;
  return doc.body;
}

/** Extract readable text from an element, with noise removed. */
export function readableText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(NOISE_SELECTORS).forEach((n) => n.remove());
  const raw = (clone as HTMLElement).innerText ?? clone.textContent ?? '';
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line, i, arr) => line.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join('\n')
    .trim();
}
