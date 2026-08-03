import type { BackgroundFit, Rect, Size } from '../types';

/**
 * The ONLY place fit/crop/mirror math lives.
 *
 * The live path (on-device, per frame) and the offline bake path (native
 * re-encode) must frame the background identically — if they diverge, the user
 * records one thing and uploads another. Both paths call into these functions
 * rather than re-deriving the math, so a parity bug has exactly one home.
 *
 * Every function here is pure and worklet-safe: no closures over mutable state,
 * no imports beyond types.
 */

export interface BackgroundLayout {
  /** Region of the background image to sample, in background pixel coords. */
  source: Rect;
  /** Region of the frame to draw it into, in frame pixel coords. */
  destination: Rect;
}

const EPSILON = 1e-6;

export function aspectRatio(size: Size): number {
  'worklet';
  if (size.height <= 0) return 0;
  return size.width / size.height;
}

export function isDegenerate(size: Size): boolean {
  'worklet';
  return !(size.width > EPSILON) || !(size.height > EPSILON);
}

/**
 * Maps a background of `background` size onto a frame of `frame` size.
 *
 * - `cover` crops the background's overflowing axis and fills the frame, so
 *   `destination` is always the full frame.
 * - `contain` samples the whole background and letterboxes it centered inside
 *   the frame, so `source` is always the full background.
 *
 * A degenerate input (zero/negative width or height) yields an empty layout
 * rather than NaNs — callers can draw it as a no-op.
 */
export function computeBackgroundLayout(
  background: Size,
  frame: Size,
  fit: BackgroundFit = 'cover',
): BackgroundLayout {
  'worklet';
  const empty = {
    source: { x: 0, y: 0, width: 0, height: 0 },
    destination: { x: 0, y: 0, width: 0, height: 0 },
  };
  if (isDegenerate(background) || isDegenerate(frame)) return empty;

  const backgroundRatio = aspectRatio(background);
  const frameRatio = aspectRatio(frame);

  if (fit === 'cover') {
    // Crop the axis that is proportionally larger than the frame's.
    let cropWidth = background.width;
    let cropHeight = background.height;
    if (backgroundRatio > frameRatio) {
      cropWidth = background.height * frameRatio;
    } else {
      cropHeight = background.width / frameRatio;
    }
    return {
      source: {
        x: (background.width - cropWidth) / 2,
        y: (background.height - cropHeight) / 2,
        width: cropWidth,
        height: cropHeight,
      },
      destination: { x: 0, y: 0, width: frame.width, height: frame.height },
    };
  }

  // contain — scale the whole background down to fit, then center it.
  let drawWidth = frame.width;
  let drawHeight = frame.height;
  if (backgroundRatio > frameRatio) {
    drawHeight = frame.width / backgroundRatio;
  } else {
    drawWidth = frame.height * backgroundRatio;
  }
  return {
    source: { x: 0, y: 0, width: background.width, height: background.height },
    destination: {
      x: (frame.width - drawWidth) / 2,
      y: (frame.height - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    },
  };
}

/**
 * Flips a rect horizontally inside a container of `containerWidth`.
 *
 * The front-facing preview is mirrored while recorded files are not, so the
 * live path mirrors the background to match the mirrored camera image and the
 * offline path does not. Both go through this function so the two can be
 * reasoned about — and tested — against one another.
 */
export function mirrorRectHorizontally(rect: Rect, containerWidth: number): Rect {
  'worklet';
  return {
    x: containerWidth - rect.x - rect.width,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

/** Quarter-turn count, clockwise. Anything outside 0..3 is normalized. */
export type QuarterTurns = 0 | 1 | 2 | 3;

export function normalizeQuarterTurns(turns: number): QuarterTurns {
  'worklet';
  const wrapped = ((Math.round(turns) % 4) + 4) % 4;
  return wrapped as QuarterTurns;
}

/** Swaps width/height for odd quarter turns. */
export function rotateSize(size: Size, turns: number): Size {
  'worklet';
  const normalized = normalizeQuarterTurns(turns);
  if (normalized === 1 || normalized === 3) {
    return { width: size.height, height: size.width };
  }
  return { width: size.width, height: size.height };
}

/**
 * Scale factor that maps `from` onto `to` under the given fit — the uniform
 * scale both renderers must apply so a background lands at the same size in the
 * preview and in the baked file.
 */
export function fitScale(from: Size, to: Size, fit: BackgroundFit = 'cover'): number {
  'worklet';
  if (isDegenerate(from) || isDegenerate(to)) return 0;
  const scaleX = to.width / from.width;
  const scaleY = to.height / from.height;
  return fit === 'cover' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
}
