import { describe, expect, it } from 'vitest';
import {
  detectIncompatibility,
  parseSkillFrontmatter,
  rawGithubUrl,
  slugifySkillName,
} from './skillImport';

describe('slugifySkillName', () => {
  it('coerces to lowercase kebab', () => {
    expect(slugifySkillName('Changelog Generator')).toBe('changelog-generator');
    expect(slugifySkillName('PDF_Filler!!')).toBe('pdf-filler');
  });

  it('falls back when nothing usable remains', () => {
    expect(slugifySkillName('   ')).toBe('imported-skill');
  });
});

describe('rawGithubUrl', () => {
  it('rewrites a blob URL to raw.githubusercontent.com', () => {
    expect(rawGithubUrl('https://github.com/owner/repo/blob/main/skills/pdf/SKILL.md')).toBe(
      'https://raw.githubusercontent.com/owner/repo/main/skills/pdf/SKILL.md',
    );
  });

  it('passes a raw URL through unchanged', () => {
    const raw = 'https://raw.githubusercontent.com/owner/repo/main/SKILL.md';
    expect(rawGithubUrl(raw)).toBe(raw);
  });
});

describe('parseSkillFrontmatter', () => {
  it('splits frontmatter from the markdown body and slugifies the name', () => {
    const md = ['---', 'name: Changelog Generator', 'description: "Make release notes"', '---', '', '# Steps', '1. Do it'].join(
      '\n',
    );
    const parsed = parseSkillFrontmatter(md);
    expect(parsed.name).toBe('changelog-generator');
    expect(parsed.description).toBe('Make release notes');
    expect(parsed.body).toBe('# Steps\n1. Do it');
  });

  it('handles CRLF line endings', () => {
    const md = '---\r\nname: foo\r\ndescription: bar\r\n---\r\nBody here';
    const parsed = parseSkillFrontmatter(md);
    expect(parsed.name).toBe('foo');
    expect(parsed.body).toBe('Body here');
  });

  it('returns empty name/description and the whole text as body when unfenced', () => {
    const parsed = parseSkillFrontmatter('Just instructions, no frontmatter.');
    expect(parsed.name).toBe('');
    expect(parsed.description).toBe('');
    expect(parsed.body).toBe('Just instructions, no frontmatter.');
  });
});

describe('detectIncompatibility', () => {
  it('flags skills that reference bundled scripts', () => {
    expect(detectIncompatibility('Run scripts/fill_pdf.py with the data.')).not.toBeNull();
  });

  it('flags Python/shell tooling', () => {
    expect(detectIncompatibility('First, pip install the dependencies, then run the script.')).not.toBeNull();
  });

  it('flags an allowed-tools list naming Bash', () => {
    expect(detectIncompatibility('allowed-tools: Bash, Read')).not.toBeNull();
  });

  it('passes a pure instruction skill', () => {
    expect(
      detectIncompatibility('Search the web, read the top results, and summarize with citations.'),
    ).toBeNull();
  });
});
