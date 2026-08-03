import type { BackgroundSource } from '../types';

/**
 * The id meaning "no background".
 *
 * A sentinel rather than `undefined` because the selection usually round-trips
 * through something stringly-typed — a navigation param, a stored preference —
 * where "absent" and "explicitly none" are worth telling apart. Every helper here
 * treats the two identically, so a consumer that has no such round trip can
 * ignore it.
 */
export const BACKGROUND_NONE = 'none';

/** Whether an id represents a real background rather than "none"/absent. */
export const isBackgroundSelected = (id: string | undefined | null): boolean =>
  id != null && id !== BACKGROUND_NONE;

/**
 * Looks a background up by id, treating `'none'`, `null` and `undefined` alike.
 *
 * Generic in the element type so a consumer that has widened `BackgroundSource`
 * with its own fields — a display label, an analytics key — gets its own type
 * back rather than the base one.
 */
export const findBackground = <T extends BackgroundSource>(
  backgrounds: readonly T[],
  id: string | undefined | null,
): T | undefined =>
  isBackgroundSelected(id) ? backgrounds.find((background) => background.id === id) : undefined;

/**
 * Whether there is anything to composite.
 *
 * Its own function because it is one of the two conditions of the availability
 * gate, and an empty background list is a real state: a consumer that replaces
 * the bundled defaults with its own remotely-configured list starts out with
 * none.
 */
export const hasBackgrounds = (backgrounds: readonly BackgroundSource[]): boolean =>
  backgrounds.length > 0;
