import { describe, expect, it } from 'vitest';
import {
  bumpSkillVersion,
  compareSkillVersions,
  detectIncompatibility,
  parseSkillFrontmatter,
  parseSkillZip,
  rawGithubUrl,
  shouldReplaceSkill,
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

describe('parseSkillFrontmatter — version and allowed-tools', () => {
  it('reads version and comma-separated allowed-tools', () => {
    const md = [
      '---',
      'name: PDF filler',
      'description: Fill a PDF form',
      'version: 1.2.0',
      'allowed-tools: search_web, get_tab_content',
      '---',
      'Steps here',
    ].join('\n');
    const parsed = parseSkillFrontmatter(md);
    expect(parsed.version).toBe('1.2.0');
    expect(parsed.declaredTools).toEqual(['search_web', 'get_tab_content']);
  });

  it('leaves version/declaredTools undefined when absent', () => {
    const md = ['---', 'name: foo', 'description: bar', '---', 'Body'].join('\n');
    const parsed = parseSkillFrontmatter(md);
    expect(parsed.version).toBeUndefined();
    expect(parsed.declaredTools).toBeUndefined();
  });
});

describe('compareSkillVersions', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareSkillVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareSkillVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSkillVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('treats missing/non-numeric segments as 0', () => {
    expect(compareSkillVersions('1.2', '1.2.1')).toBeLessThan(0);
    expect(compareSkillVersions('1.2.0', '1.2')).toBe(0); // missing segment == 0
    expect(compareSkillVersions(undefined, undefined)).toBe(0);
  });
});

describe('shouldReplaceSkill', () => {
  it('always replaces when either side has no version (historical behavior)', () => {
    expect(shouldReplaceSkill(undefined, '1.0.0')).toBe(true);
    expect(shouldReplaceSkill('1.0.0', undefined)).toBe(true);
    expect(shouldReplaceSkill(undefined, undefined)).toBe(true);
  });

  it('replaces with an equal or newer version', () => {
    expect(shouldReplaceSkill('1.0.0', '1.0.0')).toBe(true);
    expect(shouldReplaceSkill('1.0.0', '1.1.0')).toBe(true);
  });

  it('rejects an older version', () => {
    expect(shouldReplaceSkill('2.0.0', '1.9.0')).toBe(false);
  });
});

describe('bumpSkillVersion', () => {
  it('starts a fresh skill at 1.0.0', () => {
    expect(bumpSkillVersion(undefined)).toBe('1.0.0');
  });

  it('patch-bumps an existing version', () => {
    expect(bumpSkillVersion('1.2.3')).toBe('1.2.4');
    expect(bumpSkillVersion('1.2')).toBe('1.2.1');
  });
});

describe('parseSkillZip', () => {
  it('extracts every SKILL.md-shaped member, skipping non-skill files', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const skillMd = ['---', 'name: Zip Skill', 'description: From a zip', '---', 'Do the thing'].join('\n');
    const nested = ['---', 'name: Nested Skill', 'description: In a subfolder', 'version: 2.0.0', '---', 'Nested steps'].join('\n');
    const zip = zipSync({
      'SKILL.md': strToU8(skillMd),
      'README.md': strToU8('# Not a skill, no frontmatter'),
      'pack/nested/SKILL.md': strToU8(nested),
      'pack/script.py': strToU8('print("ignored, not .md")'),
    });
    const skills = parseSkillZip(zip);
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name).sort()).toEqual(['nested-skill', 'zip-skill']);
    expect(skills.find((s) => s.name === 'nested-skill')?.version).toBe('2.0.0');
  });

  it('returns an empty array for a zip with no skill-shaped .md files', async () => {
    const { zipSync, strToU8 } = await import('fflate');
    const zip = zipSync({ 'README.md': strToU8('no frontmatter here') });
    expect(parseSkillZip(zip)).toEqual([]);
  });
});
