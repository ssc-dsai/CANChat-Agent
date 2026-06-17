import { describe, expect, it } from 'vitest';
import { parseReflectionVerdict, parseSummaryArray } from './loopHelpers';

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
