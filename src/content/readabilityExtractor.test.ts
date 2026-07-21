// @vitest-environment jsdom
//
// Regression coverage for the shadow-DOM text-extraction gap: pages that render
// their content inside open shadow roots (new Reddit's shreddit-* web components,
// Salesforce Lightning, many design systems) used to extract as empty because
// textContent / innerText / querySelectorAll all stop at the shadow boundary.

import { describe, expect, it } from 'vitest';
import { collectDeepText, pickMainContent, readableText } from './readabilityExtractor';

function reset() {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
}

describe('readableText — shadow DOM', () => {
  it('recovers content rendered inside an open shadow root (the Reddit case)', () => {
    reset();
    const host = document.createElement('shreddit-post');
    host.setAttribute('id', 'post');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<article><h1>lazy-tmux v0.2.0 released!</h1>' +
      '<p>THE ACTUAL POST BODY the user wants summarized.</p></article>';
    document.body.appendChild(host);

    // Baseline: the old light-DOM approach would see nothing.
    expect(host.textContent).toBe('');

    const text = readableText(document.body);
    expect(text).toContain('lazy-tmux v0.2.0 released!');
    expect(text).toContain('THE ACTUAL POST BODY the user wants summarized.');
  });

  it('resolves <slot>-projected light content exactly once', () => {
    reset();
    const card = document.createElement('x-card');
    const root = card.attachShadow({ mode: 'open' });
    // Template text + a slot that projects the light child.
    root.innerHTML = '<section>Card chrome</section><slot></slot>';
    const body = document.createElement('p');
    body.textContent = 'Slotted body paragraph.';
    card.appendChild(body);
    document.body.appendChild(card);

    const text = collectDeepText(document.body);
    expect(text).toContain('Card chrome');
    expect(text).toContain('Slotted body paragraph.');
    // Projected content must appear once, not duplicated by walking both trees.
    expect(text.match(/Slotted body paragraph\./g)).toHaveLength(1);
  });

  it('drops noise (script/style/nav) inside shadow roots', () => {
    reset();
    const host = document.createElement('web-widget');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<nav>skip menu</nav><style>.x{color:red}</style>' +
      '<main><p>Keep this sentence.</p></main>' +
      '<script>console.log("noise")</script>';
    document.body.appendChild(host);

    const text = readableText(document.body);
    expect(text).toContain('Keep this sentence.');
    expect(text).not.toContain('skip menu');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('noise');
  });

  it('nested shadow roots are traversed to the leaf content', () => {
    reset();
    const outer = document.createElement('outer-el');
    const outerRoot = outer.attachShadow({ mode: 'open' });
    const inner = document.createElement('inner-el');
    const innerRoot = inner.attachShadow({ mode: 'open' });
    innerRoot.innerHTML = '<p>Deeply nested text.</p>';
    outerRoot.appendChild(inner);
    document.body.appendChild(outer);

    expect(readableText(document.body)).toContain('Deeply nested text.');
  });

  it('still reads ordinary light-DOM pages', () => {
    reset();
    document.body.innerHTML =
      '<article><h1>Plain title</h1><p>Ordinary paragraph body.</p></article>';
    const text = readableText(document.body);
    expect(text).toContain('Plain title');
    expect(text).toContain('Ordinary paragraph body.');
  });
});

describe('pickMainContent — shadow DOM', () => {
  it('finds a content container nested inside a shadow root', () => {
    reset();
    // jsdom reports all-zero rects, which pickMainContent treats as invisible.
    // Stub a non-zero rect so the candidate is scored on its text length, then
    // assert the deep candidate search actually returns the shadow <article>.
    const proto = Element.prototype as unknown as { getBoundingClientRect: () => DOMRect };
    const orig = proto.getBoundingClientRect;
    proto.getBoundingClientRect = () => ({ width: 800, height: 600 }) as DOMRect;
    try {
      const host = document.createElement('app-shell');
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<article id="deep"></article>';
      const article = root.getElementById('deep')!;
      article.innerHTML = '<p>' + 'x'.repeat(400) + '</p>';
      document.body.appendChild(host);

      const picked = pickMainContent(document);
      expect(picked).toBe(article); // not document.body
    } finally {
      proto.getBoundingClientRect = orig;
    }
  });
});
