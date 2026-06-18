import { describe, expect, it } from 'vitest';
import { classifyUpload, MAX_UPLOAD_BYTES } from './uploadFile';

describe('classifyUpload', () => {
  it('routes PDFs and Office files by extension', () => {
    expect(classifyUpload('report.pdf')).toBe('pdf');
    expect(classifyUpload('Brief.DOCX')).toBe('office');
    expect(classifyUpload('deck.pptx')).toBe('office');
    expect(classifyUpload('data.xlsx')).toBe('office');
  });

  it('routes text-like files by extension', () => {
    expect(classifyUpload('notes.txt')).toBe('text');
    expect(classifyUpload('README.md')).toBe('text');
    expect(classifyUpload('rows.csv')).toBe('text');
  });

  it('falls back to MIME when the extension is unknown', () => {
    expect(classifyUpload('payload', 'text/plain')).toBe('text');
    expect(classifyUpload('blob', 'application/pdf')).toBe('pdf');
    expect(classifyUpload('config', 'application/json')).toBe('text');
  });

  it('returns null for unsupported types', () => {
    expect(classifyUpload('photo.png', 'image/png')).toBeNull();
    expect(classifyUpload('archive.zip')).toBeNull();
    expect(classifyUpload('noext')).toBeNull();
  });

  it('exposes a sane size cap', () => {
    expect(MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
  });
});
