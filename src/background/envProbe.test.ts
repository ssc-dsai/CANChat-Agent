import { describe, expect, it } from 'vitest';
import { isWorkHost, parseAdUsername } from './envProbe';

describe('parseAdUsername', () => {
  it('extracts the principal after the last pipe (claims token)', () => {
    expect(parseAdUsername('i:0#.f|membership|first.last@contoso.com')).toBe('first.last@contoso.com');
  });
  it('keeps a DOMAIN\\user Windows form', () => {
    expect(parseAdUsername('0#.w|CONTOSO\\jdoe')).toBe('CONTOSO\\jdoe');
  });
  it('passes a bare username through', () => {
    expect(parseAdUsername('jdoe')).toBe('jdoe');
  });
  it('returns undefined for empty/missing', () => {
    expect(parseAdUsername('')).toBeUndefined();
    expect(parseAdUsername(null)).toBeUndefined();
    expect(parseAdUsername(undefined)).toBeUndefined();
  });
});

describe('isWorkHost', () => {
  it('matches known enterprise app hosts', () => {
    expect(isWorkHost('contoso.sharepoint.com')).toBe(true);
    expect(isWorkHost('outlook.office.com')).toBe(true);
    expect(isWorkHost('outlook.office365.com')).toBe(true);
    expect(isWorkHost('contoso.atlassian.net')).toBe(true);
    expect(isWorkHost('canada.ca')).toBe(false); // only *.gc.ca is allowlisted
    expect(isWorkHost('intranet.ssc.gc.ca')).toBe(true);
  });
  it('does not match ordinary public sites', () => {
    expect(isWorkHost('www.google.com')).toBe(false);
    expect(isWorkHost('en.wikipedia.org')).toBe(false);
    expect(isWorkHost('news.ycombinator.com')).toBe(false);
  });
});
