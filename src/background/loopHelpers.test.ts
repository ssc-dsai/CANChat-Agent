import { describe, expect, it } from 'vitest';
import { deriveStepBudget, findSimilarLesson, lessonScore, parseLesson, parseReflectionVerdict, parseSummaryArray, relevantLessons, repairToolPairing, withMergedSystemState } from './loopHelpers';
import type { LlmMessage } from './llmProvider';
import type { LessonEntry } from '../shared/types';

describe('deriveStepBudget', () => {
  it('reproduces the historical 20/10/40 defaults when unset', () => {
    expect(deriveStepBudget(undefined)).toEqual({ soft: 20, extension: 10, ceiling: 40 });
    expect(deriveStepBudget(20)).toEqual({ soft: 20, extension: 10, ceiling: 40 });
  });

  it('scales extension (round soft/2) and ceiling (soft*2)', () => {
    expect(deriveStepBudget(60)).toEqual({ soft: 60, extension: 30, ceiling: 120 });
    expect(deriveStepBudget(15)).toEqual({ soft: 15, extension: 8, ceiling: 30 });
  });

  it('clamps to [1, 1000] and floors fractional input', () => {
    expect(deriveStepBudget(0).soft).toBe(1);
    expect(deriveStepBudget(-5).soft).toBe(1);
    expect(deriveStepBudget(99999).soft).toBe(1000);
    expect(deriveStepBudget(12.9).soft).toBe(12);
  });

  it('falls back to the default for non-finite input', () => {
    expect(deriveStepBudget(NaN)).toEqual({ soft: 20, extension: 10, ceiling: 40 });
  });
});

describe('parseSummaryArray', () => {
  it('parses a plain JSON array of the expected length', () => {
    expect(parseSummaryArray('["a","b"]', 2)).toEqual(['a', 'b']);
  });

  it('strips a markdown code fence', () => {
    expect(parseSummaryArray('```json\n["x"]\n```', 1)).toEqual(['x']);
    expect(parseSummaryArray('```\n["y"]\n```', 1)).toEqual(['y']);
  });

  it('trims each entry', () => {
    expect(parseSummaryArray('["  hi  "]', 1)).toEqual(['hi']);
  });

  it('returns null on a length mismatch', () => {
    expect(parseSummaryArray('["a"]', 2)).toBeNull();
    expect(parseSummaryArray('["a","b","c"]', 2)).toBeNull();
  });

  it('returns null on non-array, non-string, or empty entries', () => {
    expect(parseSummaryArray('{"0":"a"}', 1)).toBeNull();
    expect(parseSummaryArray('[1,2]', 2)).toBeNull();
    expect(parseSummaryArray('["",""]', 2)).toBeNull();
  });

  it('returns null on invalid JSON or empty input', () => {
    expect(parseSummaryArray('not json', 1)).toBeNull();
    expect(parseSummaryArray('', 1)).toBeNull();
    expect(parseSummaryArray('["a"]', 0)).toBeNull();
  });
});

describe('parseReflectionVerdict', () => {
  it('reads an explicit revise verdict with issues', () => {
    expect(parseReflectionVerdict('{"verdict":"revise","issues":"missing source"}')).toEqual({
      revise: true,
      issues: 'missing source',
    });
  });

  it('reads an ok verdict', () => {
    expect(parseReflectionVerdict('{"verdict":"ok"}')).toEqual({ revise: false, issues: '' });
  });

  it('strips a code fence and is case-insensitive on the verdict', () => {
    expect(parseReflectionVerdict('```json\n{"verdict":"REVISE","issues":"x"}\n```').revise).toBe(true);
  });

  it('fails open on garbage, missing verdict, or empty input', () => {
    expect(parseReflectionVerdict('not json')).toEqual({ revise: false, issues: '' });
    expect(parseReflectionVerdict('{"issues":"x"}')).toEqual({ revise: false, issues: 'x' });
    expect(parseReflectionVerdict('')).toEqual({ revise: false, issues: '' });
    expect(parseReflectionVerdict('{"verdict":"maybe"}').revise).toBe(false);
  });
});

describe('repairToolPairing', () => {
  const asst = (id: string): LlmMessage => ({
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'f', arguments: '{}' } }],
  });
  const toolMsg = (id: string): LlmMessage => ({ role: 'tool', tool_call_id: id, content: 'ok' });

  it('leaves a well-formed conversation untouched', () => {
    const msgs: LlmMessage[] = [{ role: 'user', content: 'hi' }, asst('a'), toolMsg('a')];
    expect(repairToolPairing(msgs)).toEqual(msgs);
  });

  it('inserts a synthetic result for an orphaned assistant tool call', () => {
    const msgs: LlmMessage[] = [asst('a'), { role: 'user', content: 'next' }];
    const out = repairToolPairing(msgs);
    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({ role: 'tool', tool_call_id: 'a' });
    expect(out[2]).toMatchObject({ role: 'user' });
  });

  it('repairs an orphan at the end of the conversation', () => {
    const out = repairToolPairing([asst('z')]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: 'tool', tool_call_id: 'z' });
  });

  it('fills only the missing id when a call is partially answered', () => {
    const msgs: LlmMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } },
      ] },
      toolMsg('a'),
    ];
    const out = repairToolPairing(msgs);
    const toolIds = out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort();
    expect(toolIds).toEqual(['a', 'b']);
  });

  it('does not mutate the input array', () => {
    const msgs: LlmMessage[] = [asst('a')];
    repairToolPairing(msgs);
    expect(msgs).toHaveLength(1);
  });
});

describe('withMergedSystemState', () => {
  it('folds working state into the first system message instead of appending another system role', () => {
    const msgs: LlmMessage[] = [
      { role: 'system', content: 'base' },
      { role: 'user', content: 'hi' },
    ];

    const out = withMergedSystemState(msgs, '\nstate');

    expect(out.map((m) => m.role)).toEqual(['system', 'user']);
    expect(out[0].content).toBe('base\nstate');
    expect(msgs[0].content).toBe('base');
  });

  it('prepends one system message when the conversation has no system prefix', () => {
    const out = withMergedSystemState([{ role: 'user', content: 'hi' }], 'state');

    expect(out.map((m) => m.role)).toEqual(['system', 'user']);
    expect(out[0]).toEqual({ role: 'system', content: 'state' });
  });
});

describe('lesson helpers', () => {
  const lesson = (overrides: Partial<LessonEntry>): LessonEntry => ({
    id: 'l1',
    text: 'Use Outlook endpoint tools before DOM automation.',
    triggers: ['outlook mail', 'microsoft365_search'],
    tools: ['microsoft365_search'],
    uses: 1,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  });

  it('parses a high-confidence lesson and strips code fences', () => {
    expect(parseLesson('```json\n{"lesson":"Use endpoint first.","triggers":["mail"],"tools":["microsoft365_search"],"origin":null,"confidence":0.9}\n```'))
      .toMatchObject({ lesson: 'Use endpoint first.', triggers: ['mail'], tools: ['microsoft365_search'], confidence: 0.9 });
  });

  it('rejects malformed, low-confidence, or untriggered lessons', () => {
    expect(parseLesson('nope')).toBeNull();
    expect(parseLesson('{"lesson":"x","triggers":["mail"],"confidence":0.2}')).toBeNull();
    expect(parseLesson('{"lesson":"x","triggers":[],"confidence":0.9}')).toBeNull();
  });

  it('scores matching triggers and same-origin lessons higher', () => {
    const base = lesson({ origin: 'outlook.office.com' });
    expect(lessonScore(base, 'Find my Outlook mail from Brian', 'outlook.office.com')).toBeGreaterThan(
      lessonScore(base, 'Summarize this PDF', 'example.com'),
    );
  });

  it('returns only relevant lessons ordered by score', () => {
    const lessons = [
      lesson({ id: 'a', triggers: ['pdf'], text: 'Use read_pdf.' }),
      lesson({ id: 'b', triggers: ['outlook mail'], text: 'Use mail endpoint.' }),
    ];
    expect(relevantLessons(lessons, 'Search Outlook mail', '', 1).map((l) => l.id)).toEqual(['b']);
  });

  it('detects similar lessons for reinforcement', () => {
    const existing = lesson({ triggers: ['outlook mail'], origin: 'outlook.office.com' });
    const parsed = parseLesson('{"lesson":"Prefer endpoint tools for Outlook mail before web UI.","triggers":["outlook mail"],"origin":"outlook.office.com","confidence":0.95}');
    expect(parsed && findSimilarLesson([existing], parsed)?.id).toBe('l1');
  });
});
