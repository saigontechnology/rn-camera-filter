import { NitroModules } from 'react-native-nitro-modules';

import { BACKGROUND_RENDERER_HYBRID_NAME } from '../specs';
import { BackgroundFilterError } from '../util/BackgroundFilterError';

import type { BackgroundRenderer } from '../specs/BackgroundRenderer.nitro';
import type { SegmentationSupport, SegmentationUnsupportedReason } from '../types';

let cached: BackgroundRenderer | null | undefined;

/**
 * Resolves the native renderer, or `null` when the native side isn't linked
 * (Expo Go, web, a build without the package's native code).
 *
 * Cached — `createHybridObject` is not free, and the live path must not pay for
 * it per frame.
 */
export function tryGetBackgroundRenderer(): BackgroundRenderer | null {
  if (cached !== undefined) return cached;
  try {
    cached = NitroModules.hasHybridObject(BACKGROUND_RENDERER_HYBRID_NAME)
      ? NitroModules.createHybridObject<BackgroundRenderer>(BACKGROUND_RENDERER_HYBRID_NAME)
      : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Throwing variant, for call sites that cannot degrade. */
export function getBackgroundRenderer(): BackgroundRenderer {
  const renderer = tryGetBackgroundRenderer();
  if (renderer == null) {
    throw new BackgroundFilterError(
      'unsupported',
      'The native BackgroundRenderer is not available in this build.',
    );
  }
  return renderer;
}

const UNSUPPORTED_REASONS: SegmentationUnsupportedReason[] = [
  'os-version',
  'no-model',
  'unsupported-device',
];

/**
 * Narrows the native side's plain `string` back to the public union.
 *
 * The Nitro spec types `unsupportedReason` as a `string` because the union's
 * members contain dashes, which are not valid identifiers in a generated native
 * enum. An unrecognized value means native and JS have drifted, so it degrades
 * to `'unsupported-device'` rather than leaking a bogus reason to the host.
 */
function narrowReason(reason: string | undefined): SegmentationUnsupportedReason {
  const match = UNSUPPORTED_REASONS.find((candidate) => candidate === reason);
  return match ?? 'unsupported-device';
}

/**
 * Whether background replacement can run at all: the native module is linked
 * AND the device/OS supports the segmentation model.
 */
export function getSegmentationSupport(): SegmentationSupport {
  const renderer = tryGetBackgroundRenderer();
  if (renderer == null) return { supported: false, reason: 'no-model' };
  if (!renderer.isSupported) {
    return { supported: false, reason: narrowReason(renderer.unsupportedReason) };
  }
  return { supported: true };
}

/** Clears the cached instance. Test seam only. */
export function resetBackgroundRendererCache(): void {
  cached = undefined;
}
