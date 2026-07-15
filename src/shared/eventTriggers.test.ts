import { describe, expect, it } from 'vitest';
import {
  buildTriggerSkillPrompt,
  capTriggerRuns,
  isInCooldown,
  urlMatchesTrigger,
  type EventTrigger,
  type TriggerRun,
} from './eventTriggers';

const trigger: EventTrigger = {
  id: 't1',
  name: 'Jira watcher',
  enabled: true,
  hostPattern: 'jira.example.com',
  target: { kind: 'skill', name: 'jira-triage' },
  createdAt: new Date().toISOString(),
};

describe('urlMatchesTrigger', () => {
  it('matches the exact host', () => {
    expect(urlMatchesTrigger(trigger, 'https://jira.example.com/browse/ABC-1')).toBe(true);
  });

  it('matches a subdomain', () => {
    expect(urlMatchesTrigger(trigger, 'https://team.jira.example.com/board')).toBe(true);
  });

  it('rejects an unrelated host', () => {
    expect(urlMatchesTrigger(trigger, 'https://example.com/jira.example.com')).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(urlMatchesTrigger(trigger, 'not a url')).toBe(false);
  });
});

describe('isInCooldown', () => {
  it('is false when never fired', () => {
    expect(isInCooldown({ lastFiredAt: undefined, cooldownMinutes: 60 })).toBe(false);
  });

  it('is true immediately after firing (default 60min cooldown)', () => {
    expect(isInCooldown({ lastFiredAt: new Date().toISOString(), cooldownMinutes: undefined })).toBe(true);
  });

  it('is false once the cooldown window has passed', () => {
    const now = new Date('2026-01-01T01:00:00.000Z');
    const lastFiredAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    expect(isInCooldown({ lastFiredAt, cooldownMinutes: 30 }, now)).toBe(false);
  });

  it('respects a custom cooldown window', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const lastFiredAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    expect(isInCooldown({ lastFiredAt, cooldownMinutes: 30 }, now)).toBe(true);
    expect(isInCooldown({ lastFiredAt, cooldownMinutes: 5 }, now)).toBe(false);
  });
});

describe('capTriggerRuns', () => {
  it('keeps only the most recent 100 runs', () => {
    const runs: TriggerRun[] = Array.from({ length: 150 }, (_, i) => ({
      id: `r${i}`,
      triggerId: 't1',
      url: 'https://jira.example.com',
      startedAt: i,
      status: 'ok',
    }));
    const capped = capTriggerRuns(runs);
    expect(capped).toHaveLength(100);
    expect(capped[0].id).toBe('r50');
    expect(capped[capped.length - 1].id).toBe('r149');
  });
});

describe('buildTriggerSkillPrompt', () => {
  it('names the skill', () => {
    expect(buildTriggerSkillPrompt('jira-triage')).toContain('jira-triage');
  });
});
