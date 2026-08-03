/**
 * A background image. The package bundles three defaults
 * ({@link DEFAULT_BACKGROUNDS}); a consumer can inject its own instead.
 *
 * `source` accepts either:
 * - `number` — a `require(...)`d asset id.
 * - `{ uri }` — a remote or `file://` image.
 *
 * Both resolve to a URI, and decoding + texture upload happen natively in the
 * renderer. There is deliberately no pre-decoded-image variant: the live and
 * offline composites must load a background identically for the preview and the
 * baked file to match, and only the native side can do that for both.
 */
export interface BackgroundSource {
  id: string;
  source: number | { uri: string };
}

/** Why segmentation is unavailable, when it is. */
export type SegmentationUnsupportedReason = 'os-version' | 'no-model' | 'unsupported-device';

export interface SegmentationSupport {
  supported: boolean;
  reason?: SegmentationUnsupportedReason;
}

export type BackgroundEffect =
  | { kind: 'image'; id: string }
  /** Plumbed through the API surface; not implemented yet. */
  | { kind: 'blur'; radius: number }
  | { kind: 'none' };

/**
 * How a background is mapped onto the frame.
 * - `cover` — fill the frame, cropping the background's overflowing axis.
 * - `contain` — fit the whole background inside the frame, letterboxing.
 */
export type BackgroundFit = 'cover' | 'contain';

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
