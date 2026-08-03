import { NitroModules } from 'react-native-nitro-modules';

import { OFFLINE_VIDEO_PROCESSOR_HYBRID_NAME } from '../specs';
import { BackgroundFilterError } from '../util/BackgroundFilterError';

import type { BackgroundRenderer } from '../specs/BackgroundRenderer.nitro';
import type { OfflineVideoProcessor } from '../specs/OfflineVideoProcessor.nitro';

export interface StartCompositeCaptureOptions {
  /** The live renderer from `useBackgroundFilter`. */
  renderer: BackgroundRenderer;
  /** Where the composited, **video-only** file is written. */
  outputPath: string;
  /**
   * Cap the recording's height, to bound the realtime encode cost on slow devices
   * (e.g. 720).
   * @default 0 — keep the frame's own resolution.
   */
  maxOutputHeight?: number;
  /**
   * Width/height the recording should have.
   *
   * Pass what the camera's own recorder writes (e.g. `9 / 16` for a portrait
   * 720x1280 file), because the frames being composited are shaped for the
   * **preview**, not for the file — `useBackgroundFilter` matches the frame output to
   * the preview's aspect so the filtered preview shows the same field of view as the
   * unfiltered one. Leave it at 0 and a filtered recording comes out a different
   * shape than an unfiltered one.
   *
   * @default 0 — the frame's own shape.
   */
  aspectRatio?: number;
}

export interface FinishCompositeCaptureOptions {
  /**
   * A recording of the same take that has the audio — in practice the file
   * VisionCamera's own `Recorder` produced while this capture was running. Its
   * audio track is remuxed onto the composited video.
   *
   * Omit for a silent clip.
   */
  audioSourcePath?: string;
  /** Where the muxed result goes. Defaults to `<capture>-final.mp4`. */
  outputPath?: string;
}

export interface CompositeCaptureResult {
  /** The finished file: composited video plus the source's audio. */
  outputPath: string;
  /**
   * The intermediate video-only capture. Still on disk — delete it once the
   * result has been consumed. The package writes no files it does not tell you
   * about, and deletes none it did not write.
   */
  capturePath: string;
}

export interface CompositeCapture {
  /** Where the composited frames are being written, before the audio is added. */
  readonly capturePath: string;
  /**
   * Stops encoding, without muxing. Resolves with the video-only file.
   *
   * **Call this at the same moment you stop the camera's recorder** — not after its
   * file arrives, which is hundreds of milliseconds later. Alignment depends on it:
   * see {@link OfflineVideoProcessor.muxAudio}, which infers the head offset from
   * the two durations and can only do that when the capture is contained within the
   * recording.
   *
   * Idempotent: calling it twice returns the same path.
   */
  stop(): Promise<string>;
  /**
   * Muxes the audio in. Stops the capture first if {@link stop} has not run, so a
   * caller with no alignment concerns can use this alone.
   *
   * Neither track is re-encoded, so this is a file copy — a second or so for a 30 s
   * clip, not a bake.
   */
  finish(options?: FinishCompositeCaptureOptions): Promise<CompositeCaptureResult>;
  /**
   * Stops recording and throws the result away.
   *
   * Resolves with the partial file's path when one was written, so the caller can
   * delete it, and `null` when there was nothing to keep.
   */
  cancel(): Promise<string | null>;
}

let cached: OfflineVideoProcessor | null | undefined;

function tryGetProcessor(): OfflineVideoProcessor | null {
  if (cached !== undefined) return cached;
  try {
    cached = NitroModules.hasHybridObject(OFFLINE_VIDEO_PROCESSOR_HYBRID_NAME)
      ? NitroModules.createHybridObject<OfflineVideoProcessor>(OFFLINE_VIDEO_PROCESSOR_HYBRID_NAME)
      : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** Clears the cached instance. Test seam only. */
export function resetCompositeCaptureCache(): void {
  cached = undefined;
}

/**
 * Whether this build can record the composited preview directly.
 *
 * Needs both halves: the renderer's encoder, and the processor that remuxes the
 * audio onto its output. A consumer that gets `false` here should fall back to
 * recording the raw feed and baking afterwards (`processVideoBackground`).
 */
export function isCompositeCaptureSupported(renderer: BackgroundRenderer | null): boolean {
  if (renderer == null || !renderer.isCaptureSupported) return false;
  const processor = tryGetProcessor();
  return processor != null;
}

function defaultFinalPath(capturePath: string): string {
  return `${capturePath.replace(/\.[^./]+$/, '')}-final.mp4`;
}

/**
 * Records the composited frames as they are previewed.
 *
 * This is the alternative to recording the raw feed and baking the background in
 * afterwards: the file is written from the same composite the user is watching, so
 * there is no second segmentation pass, no wait at submit time, and no way for the
 * preview and the delivered clip to disagree.
 *
 * What it cannot do is record audio — the microphone belongs to the camera session.
 * Run the camera's own recorder alongside this and pass its file to
 * {@link CompositeCapture.finish}, which remuxes the audio without re-encoding
 * either track.
 *
 * Always rejects with a {@link BackgroundFilterError}.
 */
export function startCompositeCapture({
  renderer,
  outputPath,
  maxOutputHeight = 0,
  aspectRatio = 0,
}: StartCompositeCaptureOptions): CompositeCapture {
  if (!isCompositeCaptureSupported(renderer)) {
    throw new BackgroundFilterError('unsupported', 'This build cannot record composited frames.');
  }

  try {
    renderer.startCapture(outputPath, maxOutputHeight, aspectRatio);
  } catch (error) {
    throw new BackgroundFilterError('encode-failed', message(error));
  }

  // Held rather than re-run: `stop()` is called from the consumer's stop handler for
  // alignment, and again by `finish()` for callers that do not care. Both must see
  // the same outcome, and the encoder can only be stopped once.
  let stopped: Promise<string> | null = null;
  const stop = (): Promise<string> => {
    stopped ??= renderer.stopCapture().catch((error: unknown) => {
      throw new BackgroundFilterError('encode-failed', message(error));
    });
    return stopped;
  };

  return {
    capturePath: outputPath,

    stop,

    async finish(options: FinishCompositeCaptureOptions = {}): Promise<CompositeCaptureResult> {
      const capturePath = await stop();
      const { audioSourcePath } = options;
      if (audioSourcePath == null) {
        return { outputPath: capturePath, capturePath };
      }

      const processor = tryGetProcessor();
      if (processor == null) {
        throw new BackgroundFilterError(
          'unsupported',
          'The native OfflineVideoProcessor is not available in this build.',
        );
      }
      const finalPath = options.outputPath ?? defaultFinalPath(capturePath);
      try {
        return {
          outputPath: await processor.muxAudio(capturePath, audioSourcePath, finalPath),
          capturePath,
        };
      } catch (error) {
        throw new BackgroundFilterError('encode-failed', message(error));
      }
    },

    async cancel(): Promise<string | null> {
      try {
        return await stop();
      } catch {
        // A capture that never encoded a frame rejects, and native has already
        // deleted whatever it wrote. Nothing for the caller to clean up.
        return null;
      }
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
