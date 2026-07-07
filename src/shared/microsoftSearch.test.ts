import { describe, expect, it } from 'vitest';
import { buildFileKql, clampTop, normalizeFileType } from './microsoftSearch';

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
  it('defaults to a curated user-content file type filter with no filters', () => {
    const kql = buildFileKql({});
    expect(kql).toContain('filetype:docx');
    expect(kql).toContain('filetype:pdf');
    expect(kql).toContain('filetype:html');
    expect(kql).toContain('filetype:mp4');
    expect(kql).not.toContain('filetype:dll');
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
    expect(buildFileKql({ editedByMe: true }, 'Jane Doe')).toContain('Editor:"Jane Doe"');
    expect(buildFileKql({ editedByMe: true })).toContain('filetype:docx'); // no name → no editor clause
    expect(buildFileKql({ query: 'x' }, 'Jane Doe')).not.toContain('Editor:'); // name ignored without editedByMe
  });

  it('ignores malformed dates and sanitizes quotes in terms', () => {
    expect(buildFileKql({ query: "o'brien", since: 'not-a-date' })).toContain('o brien');
  });

  it('uses an explicit fileType instead of the default content-file filter', () => {
    expect(buildFileKql({ fileType: 'docx' })).toBe('filetype:docx');
  });
});
