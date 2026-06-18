import { describe, expect, it } from 'vitest';
import { normalizeSlides } from './slides';

describe('normalizeSlides', () => {
  it('keeps title, bullets, and notes; trims', () => {
    expect(
      normalizeSlides([{ title: '  Intro  ', bullets: [' a ', 'b', ''], notes: '  hi ' }]),
    ).toEqual([{ title: 'Intro', bullets: ['a', 'b'], notes: 'hi' }]);
  });

  it('accepts bullets as a newline string and alt keys (body/points)', () => {
    expect(normalizeSlides([{ title: 'T', body: 'one\n two \n' }])).toEqual([
      { title: 'T', bullets: ['one', 'two'], notes: undefined },
    ]);
    expect(normalizeSlides([{ points: ['x'] }])).toEqual([{ title: undefined, bullets: ['x'], notes: undefined }]);
  });

  it('drops fully-empty slides and non-objects', () => {
    expect(normalizeSlides([{ title: '', bullets: [] }, null, 'x', { notes: '   ' }])).toEqual([]);
  });

  it('returns [] for non-array input', () => {
    expect(normalizeSlides(undefined)).toEqual([]);
    expect(normalizeSlides('nope')).toEqual([]);
  });
});
