import { BACKGROUND_NONE, findBackground, hasBackgrounds, isBackgroundSelected } from './registry';

import type { BackgroundSource } from '../types';

const BACKGROUNDS: BackgroundSource[] = [
  { id: 'office', source: 1 },
  { id: 'studio', source: 2 },
];

describe('isBackgroundSelected', () => {
  it.each([BACKGROUND_NONE, undefined, null])('is false for %s', (id) => {
    expect(isBackgroundSelected(id)).toBe(false);
  });

  it('is true for a real id', () => {
    expect(isBackgroundSelected('office')).toBe(true);
  });
});

describe('findBackground', () => {
  it('finds by id', () => {
    expect(findBackground(BACKGROUNDS, 'studio')?.source).toBe(2);
  });

  // The three "nothing selected" spellings must behave identically, or a caller
  // that stores `'none'` in a URL param diverges from one that stores nothing.
  it.each([BACKGROUND_NONE, undefined, null, 'missing'])('returns undefined for %s', (id) => {
    expect(findBackground(BACKGROUNDS, id)).toBeUndefined();
  });

  it('preserves the caller’s widened element type', () => {
    const widened = [{ id: 'office', source: 1, labelKey: 'a' }];
    // Type-level assertion: `labelKey` is only reachable if the generic survived.
    expect(findBackground(widened, 'office')?.labelKey).toBe('a');
  });
});

describe('hasBackgrounds', () => {
  it('is false for an empty catalogue', () => {
    // Real state, not a degenerate one: a consumer whose list comes from its own
    // config starts here.
    expect(hasBackgrounds([])).toBe(false);
  });

  it('is true otherwise', () => {
    expect(hasBackgrounds(BACKGROUNDS)).toBe(true);
  });
});
