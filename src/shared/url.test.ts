import { describe, expect, it } from 'vitest';
import { collectGroupUrls, documentKindForUrl, hostMatches, normalizeHost, resolvePdfUrl } from './url';

describe('collectGroupUrls', () => {
  it('keeps http(s) tabs and carries titles', () => {
    expect(
      collectGroupUrls([
        { url: 'https://a.com/', title: 'A' },
        { url: 'http://b.com/', title: 'B' },
      ]),
    ).toEqual([
      { url: 'https://a.com/', title: 'A' },
      { url: 'http://b.com/', title: 'B' },
    ]);
  });

  it('drops non-http and empty URLs, defaults missing titles', () => {
    expect(
      collectGroupUrls([
        { url: 'chrome://extensions' },
        { url: 'about:blank' },
        { url: '' },
        { url: 'https://ok.com/' },
      ]),
    ).toEqual([{ url: 'https://ok.com/', title: '' }]);
  });

  it('dedupes by URL and caps the count', () => {
    const dup = collectGroupUrls([
      { url: 'https://x.com/', title: '1' },
      { url: 'https://x.com/', title: '2' },
    ]);
    expect(dup).toEqual([{ url: 'https://x.com/', title: '1' }]);

    const many = Array.from({ length: 20 }, (_, i) => ({ url: `https://x.com/${i}`, title: '' }));
    expect(collectGroupUrls(many, 16)).toHaveLength(16);
  });
});

describe('normalizeHost', () => {
  it('strips scheme, path, query, hash, and www', () => {
    expect(normalizeHost('https://www.Example.com/path?q=1#h')).toBe('example.com');
  });
  it('handles a bare host', () => {
    expect(normalizeHost('Example.COM')).toBe('example.com');
  });
  it('keeps non-www subdomains', () => {
    expect(normalizeHost('https://mail.google.com/')).toBe('mail.google.com');
  });
  it('trims surrounding whitespace', () => {
    expect(normalizeHost('  example.com  ')).toBe('example.com');
  });
  it('returns empty string for empty input', () => {
    expect(normalizeHost('')).toBe('');
  });
});

describe('hostMatches', () => {
  it('matches identical hosts', () => {
    expect(hostMatches('example.com', 'example.com')).toBe(true);
  });
  it('matches a subdomain of the origin', () => {
    expect(hostMatches('mail.example.com', 'example.com')).toBe(true);
  });
  it('ignores www and scheme on either side', () => {
    expect(hostMatches('https://www.example.com', 'example.com')).toBe(true);
  });
  it('does not match a different domain', () => {
    expect(hostMatches('evil.com', 'example.com')).toBe(false);
  });
  it('does not match a suffix that is not a subdomain boundary', () => {
    // notexample.com must NOT match example.com
    expect(hostMatches('notexample.com', 'example.com')).toBe(false);
  });
  it('returns false when either side is empty', () => {
    expect(hostMatches('', 'example.com')).toBe(false);
    expect(hostMatches('example.com', '')).toBe(false);
  });
});

describe('documentKindForUrl', () => {
  it('classifies Office files by extension', () => {
    expect(documentKindForUrl('https://x.sharepoint.com/sites/T/Shared%20Documents/Report.docx')).toBe('office');
    expect(documentKindForUrl('https://x.sharepoint.com/Deck.pptx')).toBe('office');
    expect(documentKindForUrl('https://x.sharepoint.com/Budget.xlsx')).toBe('office');
  });

  it('ignores query strings on the extension test', () => {
    expect(documentKindForUrl('https://x.sharepoint.com/Report.pptx?web=1&csf=1')).toBe('office');
  });

  it('classifies PDFs', () => {
    expect(documentKindForUrl('https://example.com/docs/manual.pdf')).toBe('pdf');
    expect(documentKindForUrl('https://example.com/docs/manual.pdf?download=1#page=2')).toBe('pdf');
  });

  it('unwraps Chrome PDF viewer URLs', () => {
    const pdf = 'https://example.com/docs/manual.pdf?download=1#page=2';
    const viewer = `chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html?src=${encodeURIComponent(pdf)}`;
    expect(resolvePdfUrl(viewer)).toBe(pdf);
    expect(documentKindForUrl(viewer)).toBe('pdf');
  });

  it('returns null for normal web pages', () => {
    expect(documentKindForUrl('https://example.com/articles/intro')).toBeNull();
    expect(documentKindForUrl('https://example.com/Doc.aspx?sourcedoc=%7B123%7D')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(documentKindForUrl('not a url')).toBeNull();
  });
});
