import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../shared/types';
import { askDecisionModel, askYesNo, DecisionModelError, isDecisionModelConfigured } from './decisionModel';

const base: Settings = { baseUrl: '', apiKey: '', model: '', decisionModelBaseUrl: 'http://localhost:8009' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isDecisionModelConfigured', () => {
  it('is true when a base URL is set', () => {
    expect(isDecisionModelConfigured(base)).toBe(true);
  });

  it('is false when unset or blank', () => {
    expect(isDecisionModelConfigured({ ...base, decisionModelBaseUrl: undefined })).toBe(false);
    expect(isDecisionModelConfigured({ ...base, decisionModelBaseUrl: '   ' })).toBe(false);
  });
});

describe('askDecisionModel', () => {
  it('throws without calling fetch when unconfigured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      askDecisionModel({ ...base, decisionModelBaseUrl: undefined }, 'text', { q: { type: 'noul', instructions: 'is it?' } }),
    ).rejects.toThrow(DecisionModelError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts state/model/questions to /v1/systemone and omits Authorization when no key is set', async () => {
    let url: string | undefined;
    let init: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, requestInit?: RequestInit) => {
        url = String(input);
        init = requestInit;
        return new Response(JSON.stringify({ answers: { q: { type: 'noul', noul: 0.75 } } }), { status: 200 });
      }),
    );

    const result = await askDecisionModel(base, 'the ticket text', { q: { type: 'noul', instructions: 'is it urgent?' } });

    expect(url).toBe('http://localhost:8009/v1/systemone');
    expect(JSON.parse(String(init?.body))).toEqual({
      state: 'the ticket text',
      model: 'kev-latest',
      questions: { q: { type: 'noul', instructions: 'is it urgent?' } },
    });
    expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(result.q).toEqual({ type: 'noul', probability: 0.75 });
  });

  it('includes a Bearer Authorization header when an API key is set', async () => {
    let init: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, requestInit?: RequestInit) => {
        init = requestInit;
        return new Response(JSON.stringify({ answers: { q: { type: 'noul', noul: 0.1 } } }), { status: 200 });
      }),
    );

    await askDecisionModel({ ...base, decisionModelApiKey: 'secret-token' }, 'text', { q: { type: 'noul', instructions: 'x' } });

    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });

  it('parses a choice answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        answers: { dept: { type: 'choice', choice: 'billing', probabilities: { billing: 0.6, shipping: 0.4 }, confidence: 0.2 } },
      }), { status: 200 })),
    );

    const result = await askDecisionModel(base, 'text', {
      dept: { type: 'choice', instructions: 'which team?', criteria: { billing: null, shipping: null } },
    });

    expect(result.dept).toEqual({ type: 'choice', option: 'billing', probabilities: { billing: 0.6, shipping: 0.4 }, confidence: 0.2 });
  });

  it('parses a score answer into ordered arrays by level', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({
        answers: {
          urgency: {
            type: 'score',
            score: 1.44,
            legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
            probabilities: { '0': 0, '1': 0.56, '2': 0.44 },
            confidence: 0.78,
          },
        },
      }), { status: 200 })),
    );

    const result = await askDecisionModel(base, 'text', {
      urgency: { type: 'score', instructions: 'how urgent?', criteria: ['Calm', 'Frustrated', 'Very angry'] },
    });

    expect(result.urgency).toEqual({
      type: 'score',
      index: 1.44,
      legend: ['Calm', 'Frustrated', 'Very angry'],
      probabilities: [0, 0.56, 0.44],
      confidence: 0.78,
    });
  });

  it('throws DecisionModelError on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));
    await expect(askDecisionModel(base, 'text', { q: { type: 'noul', instructions: 'x' } })).rejects.toThrow(DecisionModelError);
  });

  it('throws DecisionModelError on an unparseable response body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    await expect(askDecisionModel(base, 'text', { q: { type: 'noul', instructions: 'x' } })).rejects.toThrow(DecisionModelError);
  });

  it('throws DecisionModelError when a requested question id is missing from the response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })));
    await expect(askDecisionModel(base, 'text', { q: { type: 'noul', instructions: 'x' } })).rejects.toThrow(DecisionModelError);
  });

  it('rethrows an AbortError instead of wrapping it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    await expect(askDecisionModel(base, 'text', { q: { type: 'noul', instructions: 'x' } })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('askYesNo', () => {
  it('resolves the bare probability from a single noul question', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ answers: { decision: { type: 'noul', noul: 0.92 } } }), { status: 200 })),
    );
    await expect(askYesNo(base, 'text', 'does it?')).resolves.toBe(0.92);
  });
});
