import { describe, expect, it } from 'vitest';
import { buildWorkflowPrompt, type Workflow } from './workflows';

const workflow: Workflow = {
  id: 'wf1',
  name: 'Morning triage',
  skillNames: ['research', 'search-mail'],
  createdAt: new Date().toISOString(),
};

describe('buildWorkflowPrompt', () => {
  it('numbers each skill as an ordered use_skill step', () => {
    const prompt = buildWorkflowPrompt(workflow);
    expect(prompt).toContain('Morning triage');
    expect(prompt).toContain('1. Call use_skill for "research"');
    expect(prompt).toContain('2. Call use_skill for "search-mail"');
  });

  it('preserves skill order', () => {
    const prompt = buildWorkflowPrompt(workflow);
    expect(prompt.indexOf('research')).toBeLessThan(prompt.indexOf('search-mail'));
  });
});
