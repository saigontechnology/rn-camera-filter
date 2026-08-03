import { useEffect, useMemo } from 'react';

import { useFrameOutput } from 'react-native-vision-camera';

import { useSegmentationSupport } from './useSegmentationSupport';
import { DEFAULT_BACKGROUNDS } from '../assets/background';
import { tryGetBackgroundRenderer } from '../segmentation/renderer';
import { resolveBackgroundUri } from '../util/resolveSource';

import type { BackgroundRenderer } from '../specs/BackgroundRenderer.nitro';
import type {
  BackgroundEffect,
  BackgroundFit,
  BackgroundSource,
  SegmentationSupport,
} from '../types';
import type { CameraFrameOutput, Frame } from 'react-native-vision-camera';

export interface UseBackgroundFilterOptions {
  effect: BackgroundEffect;
  /**
   * The selectable backgrounds.
   *
   * Omit to use the package's bundled {@link DEFAULT_BACKGROUNDS}. Pass an array
   * to inject your own — doing so **replaces** the defaults rather than adding to
   * them, so a consumer that wants both spreads them explicitly:
   *
   * ```ts
   * backgrounds: [...DEFAULT_BACKGROUNDS, ...MY_BACKGROUNDS]
   * ```
   *
   * Replacing is the default because a consumer shipping a curated set almost
   * never wants three unrelated stock images appended to it.
   */
  backgrounds?: BackgroundSource[];
  fit?: BackgroundFit;
  /**
   * Mirror the background horizontally to match a mirrored front-camera preview.
   * @default false
   */
  mirror?: boolean;
  /**
   * Present the camera image mirrored, as a selfie preview normally is. Mirrors the
   * camera and its mask together, never the background.
   *
   * Pass `true` while the front camera is open, so turning the filter on does not
   * flip the subject relative to the unfiltered preview. This cannot be detected
   * for you — see `BackgroundRenderer.setCameraMirrored`.
   *
   * @default false
   */
  mirrorCamera?: boolean;
  /**
   * Target resolution for the frames this composites — **and, through them, the
   * field of view the filtered preview shows.**
   *
   * The default is deliberately **4:3**, not VisionCamera's own `HD_16_9` default,
   * because it has to match what the unfiltered preview shows. CameraX and
   * AVFoundation both give the preview output a 4:3 stream (measured: a Galaxy S22
   * negotiates `1440x1080` for `Preview`), while a 16:9 analysis stream is a
   * **crop** of that same sensor area — less field of view, before anything is
   * drawn. Composite that into the same view and the subject is noticeably larger
   * and closer than with the filter off, which reads as the filter zooming in. It
   * is not a scaling bug; the pixels genuinely cover less of the scene.
   *
   * Only the ASPECT RATIO of this matters for that. VisionCamera prioritizes the
   * ratio over the pixel count when it cannot match a resolution exactly, and
   * `enablePreviewSizedOutputBuffers` keeps the buffers small regardless.
   *
   * Override it if your camera's preview is not 4:3 — the rule is to match the
   * preview, not to maximize resolution.
   */
  targetResolution?: { width: number; height: number };
  /**
   * Composite from small, preview-sized buffers instead of full-resolution ones.
   *
   * Cheaper per frame — less bandwidth to upload, less for the segmenter to chew on —
   * and invisible while all you do is preview, since the result is scaled into a view
   * anyway.
   *
   * **It also caps what `startCapture` can record**, because the capture encodes these
   * same frames. Measured on a Galaxy S22: `true` yields a 960x720 buffer and a
   * 540x960 recording; `false` yields the full negotiated stream. Leave it `false`
   * when you record, set it `true` when you only preview.
   *
   * @default false
   */
  previewSizedFrames?: boolean;
}

export interface UseBackgroundFilterResult {
  /**
   * Attach to `<Camera outputs={[...]} />`. `null` when the effect is `'none'` or
   * the device is unsupported — pass nothing extra to the camera in that case.
   */
  frameOutput: CameraFrameOutput | null;
  /** Pass to `<BackgroundRendererView renderer={...} />`. `null` when inactive. */
  renderer: BackgroundRenderer | null;
  support: SegmentationSupport;
}

/**
 * 4:3, matching the stream the camera gives its PREVIEW output — see
 * {@link UseBackgroundFilterOptions.targetResolution} for why that ratio and not
 * VisionCamera's 16:9 default.
 *
 * The **ratio** is the load-bearing part. The pixel count is the frame-rate dial: these
 * frames are segmented, composited, drawn twice and encoded, all inside one frame
 * interval, and the 9:16 crop of them is what the recording ends up being.
 *
 * ### Why 960x1280 and not 1440x1920
 *
 * Measured end to end — frame rate is encoded frames ÷ duration of the resulting file,
 * which is exact, since the capture encodes one frame per frame delivered.
 *
 * | Request   | Stream    | Recording | Galaxy S22    | iPhone 11        |
 * | --------- | --------- | --------- | ------------- | ---------------- |
 * | preview   | 960x720   | 540x960   | 29.9 fps      | —                |
 * | 960x1280  | 1440x1080 | 810x1440  | **28.7 fps**  | —                |
 * | 1440x1920 | 1920x1440 | 1080x1920 | **22.2 fps**  | 24.3 / 26.1 fps  |
 *
 * Full 1080p costs ~6 fps on Android and lands **under** the ≥24 fps budget on a
 * flagship, so a midrange device is worse; on an iPhone 11 it sits right ON the budget
 * (two runs, 24.3 and 26.1 — the spread is thermal/lighting, and 24.3 has no margin).
 * The preview draws from these same frames, so this is visible smoothness, not just a
 * file property.
 *
 * 810x1440 still beats the 720x1280 an unfiltered recording produces, and the app
 * compresses for streaming afterwards anyway. Raise this if a sharper file matters more
 * than frame rate — the trade is measured above, not theoretical.
 */
const PREVIEW_MATCHED_RESOLUTION = { width: 960, height: 1280 } as const;

/**
 * Wires the live background filter: a frame output whose worklet hands each frame
 * to the native renderer, and the renderer to attach to the view.
 *
 * There is no per-frame JS work beyond the single `renderFrame` call — segmentation
 * and compositing both happen natively, and no mask crosses the bridge.
 */
export function useBackgroundFilter({
  effect,
  backgrounds = DEFAULT_BACKGROUNDS,
  fit = 'cover',
  mirror = false,
  mirrorCamera = false,
  targetResolution = PREVIEW_MATCHED_RESOLUTION,
  previewSizedFrames = false,
}: UseBackgroundFilterOptions): UseBackgroundFilterResult {
  const support = useSegmentationSupport();

  // `'blur'` is plumbed through the type but not implemented, so it counts as
  // inactive rather than silently behaving like `'image'`.
  const isActive = support.supported && effect.kind === 'image';

  const renderer = useMemo(
    () => (isActive ? tryGetBackgroundRenderer() : null),
    // A new renderer per activation would drop the warmed-up segmenter, so this
    // deliberately depends only on whether the filter is on.
    [isActive],
  );

  const activeId = effect.kind === 'image' ? effect.id : undefined;
  const uri = useMemo(() => {
    if (activeId == null) return undefined;
    const background = backgrounds.find((candidate) => candidate.id === activeId);
    if (background == null) return undefined;
    try {
      return resolveBackgroundUri(background);
    } catch {
      // An unresolvable background leaves the filter off rather than failing the
      // whole camera screen; the preview shows the raw feed.
      return undefined;
    }
  }, [activeId, backgrounds]);

  // Native decodes the image and uploads a texture here, once per change — not
  // per frame.
  useEffect(() => {
    if (renderer == null) return;
    renderer.setBackground(uri, fit, mirror);
  }, [renderer, uri, fit, mirror]);

  // Separate from the background above: this flips the camera and mask, and changes
  // when the user swaps cameras rather than when the background changes.
  useEffect(() => {
    if (renderer == null) return;
    renderer.setCameraMirrored(mirrorCamera);
  }, [renderer, mirrorCamera]);

  const frameOutput = useFrameOutput({
    // MUST match the preview output's aspect ratio, or the filtered preview shows a
    // different field of view than the unfiltered one. VisionCamera defaults this to
    // `HD_16_9`, which on a 4:3 preview stream is a crop — the subject then looks
    // closer and bigger the moment a background is selected.
    targetResolution,
    // Bounds the pixel count, not the aspect ratio above. Off by default because the
    // capture encodes these same frames, so preview-sized buffers cap the recording's
    // resolution — see `previewSizedFrames`.
    enablePreviewSizedOutputBuffers: previewSizedFrames,
    // MUST be 'yuv', not 'native'.
    //
    // Both renderers read planar YUV directly — the Android shader samples the Y
    // and UV planes and does the YUV→RGB conversion itself, and MLKit reads the
    // same `ImageProxy`. `'native'` is documented to resolve to "whatever the
    // session negotiated", which on Android can be a **private** format: one with
    // no CPU-accessible planes at all. It also simply fails to configure on some
    // devices — a Galaxy S22 rejects the session outright with
    // `IllegalArgumentException: PRIVATE format with resolution 1280x720 is not
    // supported for ImageAnalysis on the device`, which surfaces as an unhandled
    // promise rejection the moment a background is selected.
    //
    // 'yuv' asks for the YUV format closest to the camera's native one, so this is
    // still the cheapest format the renderer can actually consume — the conversion
    // it avoids is the one we would otherwise pay to get *back* to YUV.
    pixelFormat: 'yuv',
    onFrame: (frame: Frame) => {
      'worklet';
      try {
        renderer?.renderFrame(frame);
      } finally {
        // The frame MUST be disposed even if rendering threw, or the camera
        // pipeline stalls on exhausted buffers.
        frame.dispose();
      }
    },
  });

  return {
    frameOutput: isActive ? frameOutput : null,
    renderer,
    support,
  };
}
