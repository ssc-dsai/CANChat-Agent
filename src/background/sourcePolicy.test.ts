import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from './llmTypes';
import {
  groundingDirective,
  normalizeRepoName,
  sourcePolicyForRepos,
  sourcePolicyPrompt,
  sourceRepositoryAllowed,
  sourceToolAllowed,
  toolsForSourcePolicy,
} from './sourcePolicy';

const tool = (name: string): ToolDefinition => ({ type: 'function', function: { name, description: '', parameters: {} } });

describe('repository source policy', () => {
  it('blocks external acquisition tools but keeps repository and output tools', () => {
    const policy = sourcePolicyForRepos(['Collective agreements']);
    expect(sourceToolAllowed(policy, 'search_web')).toBe(false);
    expect(sourceToolAllowed(policy, 'run_subtasks')).toBe(false);
    expect(sourceToolAllowed(policy, 'search_repo')).toBe(true);
    expect(sourceToolAllowed(policy, 'create_file')).toBe(true);
    expect(sourceRepositoryAllowed(policy, 'Collective agreements')).toBe(true);
    expect(sourceRepositoryAllowed(policy, 'Other repo')).toBe(false);
    expect(
      toolsForSourcePolicy(policy, [tool('search_web'), tool('search_repo'), tool('request_web_fallback')])
        .map((item) => item.function.name),
    ).toEqual(['search_repo', 'request_web_fallback']);
  });

  it('allows external tools only after explicit approval', () => {
    const policy = sourcePolicyForRepos(['r']);
    if (policy.mode === 'repo_only') policy.webApproved = true;
    expect(sourceToolAllowed(policy, 'search_web')).toBe(true);
    expect(
      toolsForSourcePolicy(policy, [tool('search_web'), tool('request_web_fallback')]).map((item) => item.function.name),
    ).toEqual(['search_web']);
  });

  it('leaves ordinary turns unrestricted', () => {
    expect(sourceToolAllowed(sourcePolicyForRepos([]), 'search_web')).toBe(true);
  });

  it('prioritizes the selected repository in the prompt', () => {
    const policy = sourcePolicyForRepos(['Research']);
    const prompt = sourcePolicyPrompt(policy);
    expect(prompt).toContain('prioritize searching');
    expect(prompt).toContain('"Research"');
    expect(prompt).toContain('search_repo');
  });

  it('is case-insensitive for repository checks and deduplication', () => {
    const policy = sourcePolicyForRepos(['Research', 'research ', ' RESEARCH']);
    expect(policy.mode).toBe('repo_only');
    if (policy.mode === 'repo_only') expect(policy.repos).toEqual(['Research']);
    expect(sourceRepositoryAllowed(policy, 'RESEARCH')).toBe(true);
    expect(sourceRepositoryAllowed(policy, 'research')).toBe(true);
    expect(normalizeRepoName('  Research ')).toBe('research');
  });
});

describe('groundingDirective', () => {
  const page = { url: 'https://example.com/a', title: 'Example' };

  it('does nothing when a knowledge base is selected', () => {
    expect(groundingDirective(sourcePolicyForRepos(['kb']), page)).toBe('');
  });

  it('grounds in the active tab with a web-search fallback', () => {
    const d = groundingDirective(sourcePolicyForRepos([]), page);
    expect(d).toContain('active tab: "Example" https://example.com/a');
    expect(d).toContain('get_tab_content');
    expect(d).toContain('search_web');
  });

  it('goes straight to web search without a readable tab', () => {
    for (const tab of [null, { url: 'chrome://newtab/', title: 'New Tab' }, { url: 'about:blank', title: '' }]) {
      const d = groundingDirective(sourcePolicyForRepos([]), tab);
      expect(d).toContain('no readable active tab');
      expect(d).not.toContain('get_tab_content');
    }
  });
});
