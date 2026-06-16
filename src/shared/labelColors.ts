// =============================================================================
// Fixed, theme-aware palette for conversation labels. Pure and dependency-free
// so it's unit-testable and shared between the registry editor (LabelPicker)
// and the History list. Colours are referenced by *key*; the actual light/dark
// values live in styles.css as `--chip-<key>-bg` / `--chip-<key>-fg`, applied
// by the `.chip-color-<key>` classes.
// =============================================================================

/** The eight palette keys, in the order they appear in the swatch picker. */
export const LABEL_COLORS = [
  'red',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
  'slate',
] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

/** Default colour for a newly created label. */
export const DEFAULT_LABEL_COLOR: LabelColor = 'blue';

/**
 * CSS class for a label chip/swatch of the given palette key. Unknown or empty
 * keys fall back to `slate` so a stale colour never renders unstyled.
 */
export function labelColorClass(color: string): string {
  const key = (LABEL_COLORS as readonly string[]).includes(color) ? color : 'slate';
  return `chip-color-${key}`;
}
