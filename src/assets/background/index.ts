import type { BackgroundSource } from '../../types';

/**
 * Ids of the backgrounds bundled with the package.
 *
 * Stable strings, not indices — a consumer persists the selected id (this app
 * forwards it as a URL param), so reordering this list must not change which
 * background a saved id refers to.
 */
export const DEFAULT_BACKGROUND_IDS = ['office', 'studio', 'library'] as const;

export type DefaultBackgroundId = (typeof DEFAULT_BACKGROUND_IDS)[number];

/**
 * The backgrounds bundled with the package, used when a consumer does not inject
 * its own.
 *
 * `require` rather than `import`: these resolve through the React Native asset
 * registry to an opaque asset id, which is what `resolveBackgroundUri` turns into
 * a URI the native side can decode. A static `import` would make bundlers try to
 * treat them as modules.
 *
 * All three are **1080x1920** — the portrait frame the composite targets — so a
 * `cover` fit is 1:1 with no runtime scaling in either direction.
 *
 * They were originally shipped at their source resolutions (up to 8192x5464), and
 * that **crashed the app on Android**: a consumer rendering one as a thumbnail
 * decodes the full asset, and 8192x5464 RGBA is 171 MB, over the ~100 MB ceiling
 * `Canvas.throwIfCannotDraw` enforces — `RuntimeException: trying to draw too
 * large (179044352 bytes) bitmap`. The native renderers' `MAX_BACKGROUND_EDGE_PX`
 * downscale never applied there, because that path is the consumer's image loader,
 * not ours. Re-exporting at the target size fixes it at the source and cut the
 * bundled assets from 5.8 MB to 892 KB.
 *
 * Keep any replacement at or near 1080x1920. `MAX_BACKGROUND_EDGE_PX` still guards
 * the native decode, but nothing in this package can guard a consumer's thumbnail.
 */
export const DEFAULT_BACKGROUNDS: BackgroundSource[] = [
  { id: 'office', source: require('./bg-office.jpg') as number },
  { id: 'studio', source: require('./bg-studio.jpg') as number },
  { id: 'library', source: require('./bg-library.jpg') as number },
];

/**
 * Longest edge a decoded background is allowed to keep, in pixels.
 *
 * 1920 covers a 1080x1920 portrait frame at full quality with nothing to spare
 * wasted; anything larger is scaled down at decode time on both platforms. It is
 * also comfortably inside the smallest `GL_MAX_TEXTURE_SIZE` we expect to meet.
 */
export const MAX_BACKGROUND_EDGE_PX = 1920;
