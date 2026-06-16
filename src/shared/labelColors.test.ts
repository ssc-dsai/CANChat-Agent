import { describe, expect, it } from 'vitest';
import { DEFAULT_LABEL_COLOR, LABEL_COLORS, labelColorClass } from './labelColors';

describe('labelColors', () => {
  it('exposes eight unique palette keys', () => {
    expect(LABEL_COLORS).toHaveLength(8);
    expect(new Set(LABEL_COLORS).size).toBe(8);
  });

  it('maps a known key to its chip class', () => {
    expect(labelColorClass('green')).toBe('chip-color-green');
  });

  it('falls back to slate for unknown or empty keys', () => {
    expect(labelColorClass('chartreuse')).toBe('chip-color-slate');
    expect(labelColorClass('')).toBe('chip-color-slate');
  });

  it('uses a real palette key as the default', () => {
    expect(LABEL_COLORS).toContain(DEFAULT_LABEL_COLOR);
  });
});
