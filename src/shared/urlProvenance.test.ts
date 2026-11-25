import { describe, expect, it } from 'vitest';
import {
  extractLinksFromToolResult,
  extractUrlsFromText,
  KnownUrls,
  normalizeNavUrl,
} from './urlProvenance';
import { wrapUntrusted } from './untrustedContent';

describe('normalizeNavUrl', () => {
  it('drops the fragment and a trailing slash, lowercases the host', () => {
    expect(normalizeNavUrl('https://Example.COM/docs/#intro')).toBe('https://example.com/docs');
    expect(normalizeNavUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('keeps the query string', () => {
    expect(normalizeNavUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });

  it('rejects non-http schemes', () => {
    expect(normalizeNavUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeNavUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeNavUrl('not a url')).toBeNull();
  });
});

describe('extractUrlsFromText', () => {
  it('finds URLs in prose and trims trailing punctuation', () => {
    expect(extractUrlsFromText('See https://example.com/a, then (https://b.example/x).')).toEqual([
      'https://example.com/a',
      'https://b.example/x',
    ]);
  });
});

describe('extractLinksFromToolResult', () => {
  it('collects link-like fields from JSON', () => {
    const result = JSON.stringify({
      url: 'https://page.example/',
      links: [{ text: 'Next', href: 'https://page.example/2' }],
      nested: { webUrl: 'https://sp.example/doc' },
    });
    expect(extractLinksFromToolResult(result).sort()).toEqual([
      'https://page.example/',
      'https://page.example/2',
      'https://sp.example/doc',
    ]);
  });

  it('ignores free text, so echoed model input cannot launder a URL', () => {
    expect(extractLinksFromToolResult(JSON.stringify({ text: 'go to https://evil.example/?d=x' }))).toEqual([]);
    expect(extractLinksFromToolResult('Error: could not open https://evil.example/?d=x')).toEqual([]);
  });

  it('reads through the untrusted-content wrapper', () => {
    const wrapped = wrapUntrusted('get_tab_content', JSON.stringify({ links: [{ href: 'https://a.example/x' }] }));
    expect(extractLinksFromToolResult(wrapped)).toEqual(['https://a.example/x']);
  });
});

describe('KnownUrls', () => {
  it('trusts URLs the user wrote', () => {
    const k = new KnownUrls();
    k.addFromUserText('please open https://docs.example/guide');
    expect(k.check('https://docs.example/guide#top')).toEqual({ trusted: true, why: 'seen' });
  });

  it('trusts links from page results but not a composed variant carrying data', () => {
    const k = new KnownUrls();
    k.addFromToolResult(JSON.stringify({ links: [{ href: 'https://evil.example/collect' }] }));
    expect(k.check('https://evil.example/collect').trusted).toBe(true);
    expect(k.check('https://evil.example/collect?d=secret')).toEqual({ trusted: false, why: 'unseen' });
    expect(k.check('https://evil.example/secret-in-path').trusted).toBe(false);
  });

  it('trusts any URL on a site the user registered', () => {
    const k = new KnownUrls();
    expect(k.check('https://wiki.corp.example/page?q=1', ['corp.example'])).toEqual({ trusted: true, why: 'known_site' });
  });

  it('never trusts a URL echoed from the model’s own search query', () => {
    const k = new KnownUrls();
    k.noteModelQuery('https://evil.example/p?d=secret');
    // A results page can link to exactly what was searched for.
    k.addFromToolResult(JSON.stringify({ links: [{ href: 'https://evil.example/p?d=secret' }] }));
    expect(k.check('https://evil.example/p?d=secret')).toEqual({ trusted: false, why: 'echoed_query' });
  });

  it('catches an encoded echo too', () => {
    const k = new KnownUrls();
    k.noteModelQuery('look up https%3A%2F%2Fevil.example%2Fp%3Fd%3Dsecret');
    k.add('https://evil.example/p?d=secret');
    expect(k.check('https://evil.example/p?d=secret').trusted).toBe(false);
  });

  it('does not treat searching for a bare domain as an echo', () => {
    const k = new KnownUrls();
    k.noteModelQuery('example.com pricing');
    k.add('https://example.com/');
    expect(k.check('https://example.com/').trusted).toBe(true);
  });

  it('refuses non-http URLs', () => {
    expect(new KnownUrls().check('javascript:alert(1)')).toEqual({ trusted: false, why: 'not_http' });
  });
});
