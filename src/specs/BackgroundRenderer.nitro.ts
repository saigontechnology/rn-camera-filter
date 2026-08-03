import type { BackgroundFit } from '../types';
import type { HybridObject } from 'react-native-nitro-modules';
import type { Frame } from 'react-native-vision-camera';

/**
 * The live compositor.
 *
 * Segmentation and compositing both happen **natively**, inside `renderFrame`.
 * No mask ever crosses into JS, there is no per-frame JS work beyond this one
 * call, and the live path shares its blend with the offline bake — which is what
 * makes preview/output parity structural rather than something to test into.
 *
 * Registered as the Nitro HybridObject `BackgroundRenderer`.
 */
export interface BackgroundRenderer extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /** Whether this device can segment at all (OS version, model availability). */
  readonly isSupported: boolean;

  /**
   * Why segmentation is unavailable, when it is.
   *
   * Typed as a plain `string` rather than the public
   * `SegmentationUnsupportedReason` union because that union's members contain
   * dashes (`'os-version'`), which are not valid identifiers in a generated
   * native enum. `getSegmentationSupport()` narrows it back at the JS boundary.
   */
  readonly unsupportedReason?: string;

  /**
   * Sets — or clears, with `undefined` — the background to composite.
   *
   * The native side decodes the URI and uploads a texture once here, not per
   * frame.
   */
  setBackground(uri: string | undefined, fit: BackgroundFit, mirror: boolean): void;

  /**
   * Whether to present the camera image mirrored, as a selfie preview normally is.
   *
   * This mirrors the **camera and its mask together** — never the background, which
   * stays unmirrored so the live preview and the baked file agree on it.
   *
   * It has to be told to us rather than inferred. `Frame.isMirrored` sounds like the
   * answer but is not: it reports mirroring for the frame output specifically, and
   * VisionCamera does not apply the session's `mirrorMode` to that output — measured
   * `isMirrored === false` on a selfie camera whose preview was plainly mirrored. And
   * the session-level `mirrorMode` cannot be used to force it, because that would
   * mirror the *recorded file* too. Only the consumer knows which camera is open and
   * what its preview looks like, so only the consumer can answer this.
   *
   * `isMirrored` is still honoured on top of this, so a build where VisionCamera does
   * mirror the frame output does not end up flipped twice.
   *
   * @default false
   */
  setCameraMirrored(mirrored: boolean): void;

  /**
   * Synchronously segments + composites `frame` and draws it to the connected
   * view. Called from the `CameraFrameOutput` worklet — deliberately the same
   * shape as VisionCamera's own `FrameRenderer.renderFrame`.
   *
   * When no background is set, or the device is unsupported, or a frame fails to
   * segment, this draws the unmodified frame — never a stale mask, which would
   * smear the previous frame's silhouette, and never nothing, which would show
   * the user a black preview.
   */
  renderFrame(frame: Frame): void;

  /**
   * Whether this device can encode the composited frames as they are rendered.
   *
   * Separate from {@link isSupported}: segmentation and hardware video encoding
   * are different subsystems, and a device can have one without the other.
   */
  readonly isCaptureSupported: boolean;

  /**
   * Starts writing every composited frame to `outputPath` as a **video-only**
   * file, from inside `renderFrame` — so the recording is the same pixels the
   * user is watching, with no second segmentation pass afterwards.
   *
   * There is no audio here and there cannot be: the microphone belongs to the
   * camera session, which hands its samples to VisionCamera's own `Recorder`.
   * The intended pairing is to run that recorder alongside this and then call
   * {@link OfflineVideoProcessor.muxAudio} to put its audio track onto this
   * file — a remux, not a re-encode, so nothing here ever owns A/V sync.
   *
   * The output is sized from the first frame's **displayed** dimensions, cropped
   * to `aspectRatio` and capped at `maxOutputHeight` on the longer edge; pass 0
   * for either to take the frame's own. Frames are timestamped from the camera,
   * so a dropped or slow frame stretches its predecessor rather than shifting
   * everything after it out of sync.
   *
   * `aspectRatio` is width/height of the **recording**, and exists because the
   * frames being composited are shaped for the PREVIEW, not for the file. The
   * frame output has to match the preview's aspect or the filtered preview shows
   * a different field of view than the unfiltered one — which on Android means
   * 4:3 frames, while the camera's own recorder writes 16:9. Left at 0, a
   * filtered recording would come out a different shape than an unfiltered one.
   * Pass what the camera's recorder produces (e.g. `9 / 16` for a portrait
   * 720x1280 file) and the capture centre-crops to match it.
   *
   * Throws if a capture is already running, or if the encoder cannot be
   * configured. Calling this while unsupported throws rather than silently
   * recording nothing.
   */
  startCapture(outputPath: string, maxOutputHeight: number, aspectRatio: number): void;

  /**
   * Finishes the capture and resolves with the written path.
   *
   * Rejects when no capture is running, or when no frame was ever encoded — an
   * empty file would otherwise reach the consumer as a "successful" recording
   * that plays as nothing. On failure the partial file is deleted, since the
   * caller has no other way to learn it exists.
   */
  stopCapture(): Promise<string>;
}
