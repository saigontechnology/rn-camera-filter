import { DEFAULT_BACKGROUNDS } from '../assets/background';
import { hasBackgrounds, isBackgroundSelected } from '../backgrounds/registry';
import { isOfflineBakeSupported } from '../offline/processVideoBackground';
import { getSegmentationSupport } from '../segmentation/renderer';

import type { BackgroundSource } from '../types';

/**
 * Whether the background filter can actually run.
 *
 * Two independent conditions, kept in one place so the record screen and the
 * submit pipeline cannot drift on which of them they check:
 *
 * 1. **Device support** — the native renderer is linked and the OS can segment
 *    (iOS 15+ / MLKit present).
 * 2. **Assets** — there is at least one background to composite.
 *
 * There is deliberately **no feature flag here**. Gating on a remote flag makes
 * behaviour depend on whether the device reached your config service, which is
 * not a property of the device and cannot be reproduced on a test bench. If you
 * want a staged rollout, `&&` your own flag onto the result at the call site —
 * that keeps "can this device do it" and "should this user get it" separable.
 */
export const isBackgroundFilterAvailable = (options?: {
  /** Defaults to the package's bundled backgrounds. */
  backgrounds?: readonly BackgroundSource[];
}): boolean =>
  hasBackgrounds(options?.backgrounds ?? DEFAULT_BACKGROUNDS) && getSegmentationSupport().supported;

export interface ShouldBakeBackgroundOptions {
  /** The selected background id — `'none'`/`undefined` means nothing to bake. */
  background: string | undefined | null;
  /**
   * Whether the background is **already composited into the file**, from the
   * record-time capture.
   *
   * Describes the FILE, not the user's selection: a capture that failed and fell
   * back to the raw recording must report `false` even though a background was
   * picked, or the clip uploads without it.
   */
  alreadyComposited?: boolean;
  /** Injectable for tests; defaults to {@link isBackgroundFilterAvailable}. */
  filterAvailable?: boolean;
  /** Injectable for tests; defaults to the native probe. */
  bakeSupported?: boolean;
  /** Passed through to {@link isBackgroundFilterAvailable} when it is used. */
  backgrounds?: readonly BackgroundSource[];
}

/**
 * Whether a recorded clip still needs the background baked into it before upload.
 *
 * Pure, with every capability injectable, so the decision is testable without a
 * device or a mounted screen.
 *
 * `alreadyComposited` is checked first because it is the only condition that
 * describes the file rather than what the device can do — and baking a clip that
 * already has a background would segment the composite instead of the person,
 * which looks far worse than not baking at all.
 *
 * Note the two capabilities are probed **separately**. The live renderer needs
 * Metal/GLES; the bake needs a working encoder and muxer. A device can have one
 * without the other, and the asymmetric case — live filter on, bake unavailable —
 * is the dangerous one: the user watches a background and uploads a clip without
 * it, which reads as data loss.
 */
export const shouldBakeBackground = (params: ShouldBakeBackgroundOptions): boolean => {
  const {
    background,
    alreadyComposited = false,
    backgrounds,
    filterAvailable = isBackgroundFilterAvailable({ backgrounds }),
    bakeSupported = isOfflineBakeSupported(),
  } = params;

  if (alreadyComposited) return false;
  if (!filterAvailable || !bakeSupported) return false;
  return isBackgroundSelected(background);
};
