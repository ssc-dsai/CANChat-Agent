import { describe, expect, it } from 'vitest';
import { buildFileKql, buildMailQuery, clampTop, normalizeFileType } from './microsoftSearch';

describe('clampTop', () => {
  it('defaults to 10 and clamps to [1, 25]', () => {
    expect(clampTop(undefined)).toBe(10);
    expect(clampTop(0)).toBe(1);
    expect(clampTop(5)).toBe(5);
    expect(clampTop(100)).toBe(25);
    expect(clampTop(3.9)).toBe(3);
  });
});

describe('normalizeFileType', () => {
  it('strips a leading dot and lowercases', () => {
    expect(normalizeFileType('.DOCX')).toBe('docx');
    expect(normalizeFileType('pdf')).toBe('pdf');
  });
  it('rejects junk', () => {
    expect(normalizeFileType('a b')).toBeUndefined();
    expect(normalizeFileType('')).toBeUndefined();
  });
});

describe('buildFileKql', () => {
  it('falls back to IsDocument:1 with no filters', () => {
    expect(buildFileKql({})).toBe('IsDocument:1');
  });

  it('combines terms, filetype, site path, and date range', () => {
    const kql = buildFileKql({
      query: 'budget',
      fileType: 'docx',
      sitePath: 'https://contoso.sharepoint.com/sites/Finance',
      since: '2024-01-01',
      until: '2024-12-31',
    });
    expect(kql).toBe(
      'budget filetype:docx path:"https://contoso.sharepoint.com/sites/Finance" LastModifiedTime>=2024-01-01 LastModifiedTime<=2024-12-31',
    );
  });

  it('adds an Editor clause only when editedByMe + a resolved name are present', () => {
    expect(buildFileKql({ editedByMe: true }, 'Jane Doe')).toBe('Editor:"Jane Doe"');
    expect(buildFileKql({ editedByMe: true })).toBe('IsDocument:1'); // no name → no clause
    expect(buildFileKql({ query: 'x' }, 'Jane Doe')).toBe('x'); // name ignored without editedByMe
  });

  it('ignores malformed dates and sanitizes quotes in terms', () => {
    expect(buildFileKql({ query: "o'brien", since: 'not-a-date' })).toBe('o brien');
  });
});

describe('buildMailQuery', () => {
  it('is empty with no filters (list recent)', () => {
    expect(buildMailQuery({})).toBe('');
  });

  it('quotes a multi-word sender and adds a received range', () => {
    expect(buildMailQuery({ from: 'Brian Ray', since: '2024-03-01' })).toBe(
      'from:"Brian Ray" received>=2024-03-01',
    );
  });

  it('does not quote a single-token sender (email)', () => {
    expect(buildMailQuery({ from: 'brian@contoso.com' })).toBe('from:brian@contoso.com');
  });

  it('combines free text with a sender', () => {
    expect(buildMailQuery({ query: 'invoice', from: 'Ray' })).toBe('invoice from:Ray');
  });
});
