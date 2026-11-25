import { describe, expect, it } from 'vitest';
import { mimeTypeForTextFile, safeTextFilename } from './textFileSafety';

describe('safeTextFilename', () => {
  it('keeps allowlisted text extensions', () => {
    expect(safeTextFilename('notes.md')).toBe('notes.md');
    expect(safeTextFilename('data.CSV')).toBe('data.CSV');
    expect(safeTextFilename('config.yaml')).toBe('config.yaml');
  });

  it('neutralizes executable and active-content extensions', () => {
    for (const ext of ['bat', 'cmd', 'command', 'sh', 'ps1', 'vbs', 'js', 'exe', 'html', 'htm', 'svg', 'hta', 'lnk', 'url', 'desktop', 'ics', 'xml']) {
      expect(safeTextFilename(`report.${ext}`)).toBe(`report.${ext}.txt`);
    }
  });

  it('adds .txt when there is no extension', () => {
    expect(safeTextFilename('README')).toBe('README.txt');
  });

  it('strips trailing dots and spaces that Windows would drop', () => {
    expect(safeTextFilename('evil.bat. . ')).toBe('evil.bat.txt');
  });

  it('strips path parts, reserved characters and leading dots', () => {
    expect(safeTextFilename('../../.bashrc')).toBe('_.._.bashrc.txt');
    expect(safeTextFilename('.profile')).toBe('profile.txt');
    expect(safeTextFilename('a<b>:c.md')).toBe('a_b__c.md');
  });

  it('returns empty for nothing usable', () => {
    expect(safeTextFilename(' . . ')).toBe('');
  });

  it('caps very long names but keeps the extension', () => {
    const name = safeTextFilename(`${'x'.repeat(300)}.md`);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith('.md')).toBe(true);
  });

  it('maps MIME types, defaulting to text/plain', () => {
    expect(mimeTypeForTextFile('a.json')).toBe('application/json');
    expect(mimeTypeForTextFile('a.bat.txt')).toBe('text/plain');
  });
});
