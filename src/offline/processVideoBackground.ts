import { NitroModules } from 'react-native-nitro-modules';

import { OFFLINE_VIDEO_PROCESSOR_HYBRID_NAME } from '../specs';
import { BackgroundFilterError } from '../util/BackgroundFilterError';
import { resolveBackgroundUri } from '../util/resolveSource';

import type { OfflineJobResult, OfflineVideoProcessor } from '../specs/OfflineVideoProcessor.nitro';
import type { BackgroundFit, BackgroundSource } from '../types';

export interface ProcessVideoBackgroundOptions {
  /** Path of the recorded (and ideally already trimmed) input file. */
  inputPath: string;
  /** Defaults to a sibling of the input named `<name>-baked.mp4`. */
  outputPath?: string;
  background: BackgroundSource;
  fit?: BackgroundFit;
  /**
   * Mirror the background horizontally, matching a mirrored front-camera preview.
   * @default false — recorded files are not mirrored.
   */
  mirror?: boolean;
  /**
   * Cap the output's height to bound bake time on slow devices (e.g. 720).
   * @default 0 — keep the source resolution.
   */
  maxOutputHeight?: number;
  /** 0..1. Called on the JS thread, throttled natively to ~10/s. */
  onProgress?: (progress: number) => void;
  signal?: AbortSignal;
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

/** Whether an offline bake can run in this build. */
export function isOfflineBakeSupported(): boolean {
  const processor = tryGetProcessor();
  return processor != null && processor.isSupported;
}

/** Clears the cached instance. Test seam only. */
export function resetOfflineProcessorCache(): void {
  cached = undefined;
}

function defaultOutputPath(inputPath: string): string {
  const withoutExtension = inputPath.replace(/\.[^./]+$/, '');
  return `${withoutExtension}-baked.mp4`;
}

/**
 * Bakes `background` into `inputPath`, writing a new MP4.
 *
 * The audio track is copied through untouched on both platforms, so this never
 * owns A/V muxing or sync. Always rejects with a {@link BackgroundFilterError}.
 */
export async function processVideoBackground(
  options: ProcessVideoBackgroundOptions,
): Promise<OfflineJobResult> {
  const {
    inputPath,
    outputPath = defaultOutputPath(inputPath),
    background,
    fit = 'cover',
    mirror = false,
    maxOutputHeight = 0,
    onProgress,
    signal,
  } = options;

  const processor = tryGetProcessor();
  if (processor == null || !processor.isSupported) {
    throw new BackgroundFilterError(
      'unsupported',
      'The native OfflineVideoProcessor is not available in this build.',
    );
  }
  if (signal?.aborted === true) {
    throw new BackgroundFilterError('cancelled', 'Aborted before the bake started.');
  }

  // Resolve the URI before starting so an unusable background fails fast rather
  // than after the decoder has spun up.
  const uri = resolveBackgroundUri(background);

  const job = processor.start({
    inputPath,
    outputPath,
    background: { uri, fit, mirror },
    maxOutputHeight,
  });

  if (onProgress != null) job.setOnProgress(onProgress);

  // Read through a function, not the narrowed `signal.aborted` from the
  // pre-flight check above — by the time the job rejects, it may have flipped.
  const wasAborted = () => signal?.aborted ?? false;

  const onAbort = () => job.cancel();
  signal?.addEventListener('abort', onAbort);

  try {
    return await job.result();
  } catch (error) {
    if (error instanceof BackgroundFilterError) throw error;
    if (wasAborted()) {
      throw new BackgroundFilterError('cancelled', 'The bake was cancelled.');
    }
    throw new BackgroundFilterError(
      'encode-failed',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    signal?.removeEventListener('abort', onAbort);
    job.setOnProgress(undefined);
  }
}
