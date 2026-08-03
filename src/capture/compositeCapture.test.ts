import { NitroModules } from 'react-native-nitro-modules';

import {
  isCompositeCaptureSupported,
  resetCompositeCaptureCache,
  startCompositeCapture,
} from './compositeCapture';
import { BackgroundFilterError } from '../util/BackgroundFilterError';

import type { BackgroundRenderer } from '../specs/BackgroundRenderer.nitro';
import type { OfflineVideoProcessor } from '../specs/OfflineVideoProcessor.nitro';

const hasHybridObject = NitroModules.hasHybridObject as jest.Mock;
const createHybridObject = NitroModules.createHybridObject as jest.Mock;

const CAPTURE_PATH = '/tmp/composite.mp4';
const RAW_PATH = '/tmp/raw.mp4';

function fakeRenderer(overrides: { isCaptureSupported?: boolean } = {}) {
  const renderer = {
    isCaptureSupported: overrides.isCaptureSupported ?? true,
    startCapture: jest.fn(),
    stopCapture: jest.fn(async () => CAPTURE_PATH),
  } as unknown as BackgroundRenderer;
  return renderer;
}

function linkProcessor(muxAudio = jest.fn(async () => '/tmp/final.mp4')) {
  const processor = { isSupported: true, muxAudio } as unknown as OfflineVideoProcessor;
  hasHybridObject.mockReturnValue(true);
  createHybridObject.mockReturnValue(processor);
  return muxAudio;
}

describe('startCompositeCapture', () => {
  beforeEach(() => {
    resetCompositeCaptureCache();
    hasHybridObject.mockReset();
    createHybridObject.mockReset();
  });

  it('is unsupported when the renderer cannot encode', () => {
    linkProcessor();
    expect(isCompositeCaptureSupported(fakeRenderer({ isCaptureSupported: false }))).toBe(false);
  });

  // Both halves are needed: the capture is video-only, so without the processor
  // that muxes the audio in, a "successful" capture would deliver a silent clip.
  it('is unsupported when the offline processor is not linked', () => {
    hasHybridObject.mockReturnValue(false);
    expect(isCompositeCaptureSupported(fakeRenderer())).toBe(false);
  });

  it('rejects with code "unsupported" rather than starting a capture it cannot finish', () => {
    hasHybridObject.mockReturnValue(false);
    const renderer = fakeRenderer();
    expect(() => startCompositeCapture({ renderer, outputPath: CAPTURE_PATH })).toThrow(
      BackgroundFilterError,
    );
    expect(renderer.startCapture).not.toHaveBeenCalled();
  });

  it('muxes the recorder audio onto the captured video', async () => {
    const muxAudio = linkProcessor();
    const renderer = fakeRenderer();

    const capture = startCompositeCapture({ renderer, outputPath: CAPTURE_PATH });
    expect(renderer.startCapture).toHaveBeenCalledWith(CAPTURE_PATH, 0, 0);

    const result = await capture.finish({ audioSourcePath: RAW_PATH });

    expect(muxAudio).toHaveBeenCalledWith(CAPTURE_PATH, RAW_PATH, '/tmp/composite-final.mp4');
    expect(result).toEqual({ outputPath: '/tmp/final.mp4', capturePath: CAPTURE_PATH });
  });

  // The intermediate is the caller's to delete, so it has to come back even when
  // the mux renamed the deliverable out from under it.
  it('reports the intermediate capture path alongside the result', async () => {
    linkProcessor();
    const capture = startCompositeCapture({
      renderer: fakeRenderer(),
      outputPath: CAPTURE_PATH,
      maxOutputHeight: 720,
    });
    const { capturePath } = await capture.finish({ audioSourcePath: RAW_PATH });
    expect(capturePath).toBe(CAPTURE_PATH);
  });

  // The frames handed to the encoder are shaped for the preview, so the recording's
  // shape has to be requested explicitly or a filtered clip comes out a different
  // shape than an unfiltered one.
  it('passes the recording aspect ratio through to native', () => {
    linkProcessor();
    const renderer = fakeRenderer();

    startCompositeCapture({
      renderer,
      outputPath: CAPTURE_PATH,
      maxOutputHeight: 1920,
      aspectRatio: 9 / 16,
    });

    expect(renderer.startCapture).toHaveBeenCalledWith(CAPTURE_PATH, 1920, 9 / 16);
  });

  it('skips the mux for a silent capture', async () => {
    const muxAudio = linkProcessor();
    const capture = startCompositeCapture({ renderer: fakeRenderer(), outputPath: CAPTURE_PATH });

    const result = await capture.finish();

    expect(muxAudio).not.toHaveBeenCalled();
    expect(result.outputPath).toBe(CAPTURE_PATH);
  });

  it('wraps a native encode failure as a BackgroundFilterError', async () => {
    linkProcessor();
    const renderer = fakeRenderer();
    (renderer.stopCapture as jest.Mock).mockRejectedValue(new Error('no frames'));

    const capture = startCompositeCapture({ renderer, outputPath: CAPTURE_PATH });

    await expect(capture.finish({ audioSourcePath: RAW_PATH })).rejects.toBeInstanceOf(
      BackgroundFilterError,
    );
  });

  it('hands back the partial file to delete when cancelled', async () => {
    linkProcessor();
    const capture = startCompositeCapture({ renderer: fakeRenderer(), outputPath: CAPTURE_PATH });

    await expect(capture.cancel()).resolves.toBe(CAPTURE_PATH);
  });

  // Native deletes what it wrote when the capture produced nothing, so there is
  // no path to hand back — and a cancel must never surface as a failure.
  it('resolves null when a cancelled capture wrote nothing', async () => {
    linkProcessor();
    const renderer = fakeRenderer();
    (renderer.stopCapture as jest.Mock).mockRejectedValue(new Error('no frames'));

    const capture = startCompositeCapture({ renderer, outputPath: CAPTURE_PATH });

    await expect(capture.cancel()).resolves.toBeNull();
  });

  it('does not stop the same capture twice', async () => {
    linkProcessor();
    const renderer = fakeRenderer();
    const capture = startCompositeCapture({ renderer, outputPath: CAPTURE_PATH });

    await capture.finish({ audioSourcePath: RAW_PATH });
    await capture.cancel();

    expect(renderer.stopCapture).toHaveBeenCalledTimes(1);
  });

  // The consumer stops the encoder at the same instant it stops the camera's
  // recorder, so both tracks end together — the remux infers the head offset from
  // the difference between the two durations, and a loose tail corrupts it. The
  // later `finish()` must reuse that stop rather than fail or stop again.
  it('lets the encoder be stopped before the audio source exists', async () => {
    const muxAudio = linkProcessor();
    const renderer = fakeRenderer();
    const capture = startCompositeCapture({ renderer, outputPath: CAPTURE_PATH });

    await expect(capture.stop()).resolves.toBe(CAPTURE_PATH);

    const result = await capture.finish({ audioSourcePath: RAW_PATH });

    expect(renderer.stopCapture).toHaveBeenCalledTimes(1);
    expect(muxAudio).toHaveBeenCalledWith(CAPTURE_PATH, RAW_PATH, '/tmp/composite-final.mp4');
    expect(result.outputPath).toBe('/tmp/final.mp4');
  });

  it('reports the same failure to every caller of stop', async () => {
    linkProcessor();
    const renderer = fakeRenderer();
    (renderer.stopCapture as jest.Mock).mockRejectedValue(new Error('no frames'));
    const capture = startCompositeCapture({ renderer, outputPath: CAPTURE_PATH });

    await expect(capture.stop()).rejects.toBeInstanceOf(BackgroundFilterError);
    await expect(capture.finish({ audioSourcePath: RAW_PATH })).rejects.toBeInstanceOf(
      BackgroundFilterError,
    );
    expect(renderer.stopCapture).toHaveBeenCalledTimes(1);
  });
});
