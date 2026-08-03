import type { BackgroundFit } from '../types';
import type { HybridObject } from 'react-native-nitro-modules';

/**
 * A background handed to the offline processor. Unlike the live path, the native
 * side decodes the image itself — it runs off the JS thread and may outlive the
 * screen that started it.
 */
export interface OfflineBackground {
  /** `file://`, `http(s)://`, or an absolute path. */
  uri: string;
  fit: BackgroundFit;
  /** Mirror the background horizontally. Explicit so it can match the preview. */
  mirror: boolean;
}

export interface OfflineJobOptions {
  inputPath: string;
  outputPath: string;
  background: OfflineBackground;
  /** Cap the output's height. 0 = keep the source resolution. */
  maxOutputHeight: number;
}

export interface OfflineJobResult {
  outputPath: string;
  durationMs: number;
}

/**
 * A running bake. Held by the JS wrapper so it can report progress and cancel.
 */
export interface OfflineVideoJob extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /** 0..1. Throttled natively to ~10 calls/sec. */
  setOnProgress(onProgress: ((progress: number) => void) | undefined): void;
  /**
   * Resolves once the output file is fully written and muxed.
   * Named `result` rather than `await` because `await` is a Swift keyword and
   * would need escaping in the generated bindings.
   */
  result(): Promise<OfflineJobResult>;
  /** Cooperative — the native pipeline stops at its next frame boundary. */
  cancel(): void;
}

/**
 * Composites a background into an already-recorded file.
 *
 * iOS: `AVMutableVideoComposition(asset:applyingCIFiltersWithHandler:)` +
 * `AVAssetExportSession`, which muxes audio through untouched.
 * Android: MediaExtractor → MediaCodec → GL composite → MediaCodec → MediaMuxer,
 * with the audio track copied sample-for-sample (no re-encode, no A/V sync work).
 */
export interface OfflineVideoProcessor extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  readonly isSupported: boolean;
  start(options: OfflineJobOptions): OfflineVideoJob;

  /**
   * Copies the audio track of `audioSourcePath` onto the video track of
   * `videoPath`, writing `outputPath`. Resolves with `outputPath`.
   *
   * This is the second half of the live-capture path: the renderer writes a
   * video-only file of the composited frames while VisionCamera's recorder
   * writes the raw clip **with** audio, and this joins them.
   *
   * Neither track is re-encoded — iOS builds an `AVMutableComposition` and
   * exports it passthrough, Android copies samples through `MediaExtractor` →
   * `MediaMuxer`. So this costs a file copy, not a transcode, and no code here
   * has to resample or re-time audio. The tracks come from the same capture
   * session started at the same moment, so their timelines already agree; the
   * shorter of the two bounds the result.
   *
   * A source with no audio track is not an error — the video is copied through
   * unchanged, which is what a muted recording should produce.
   */
  muxAudio(videoPath: string, audioSourcePath: string, outputPath: string): Promise<string>;
}
