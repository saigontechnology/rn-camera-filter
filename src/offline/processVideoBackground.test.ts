import { NitroModules } from 'react-native-nitro-modules';

import {
  isOfflineBakeSupported,
  processVideoBackground,
  resetOfflineProcessorCache,
} from './processVideoBackground';
import { BackgroundFilterError } from '../util/BackgroundFilterError';

import type {
  OfflineJobResult,
  OfflineVideoJob,
  OfflineVideoProcessor,
} from '../specs/OfflineVideoProcessor.nitro';

const hasHybridObject = NitroModules.hasHybridObject as jest.Mock;
const createHybridObject = NitroModules.createHybridObject as jest.Mock;

const BACKGROUND = { id: 'bg1', source: { uri: 'file:///bg1.jpg' } };

type FakeJob = OfflineVideoJob & {
  resolve: (result: OfflineJobResult) => void;
  reject: (error: unknown) => void;
  cancelled: boolean;
  progressCallback: ((progress: number) => void) | undefined;
};

function fakeProcessor(overrides: { isSupported?: boolean } = {}) {
  let settle: { resolve: (r: OfflineJobResult) => void; reject: (e: unknown) => void };
  const promise = new Promise<OfflineJobResult>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const job = {
    cancelled: false,
    progressCallback: undefined,
    setOnProgress(callback?: (progress: number) => void) {
      job.progressCallback = callback;
    },
    result: () => promise,
    cancel() {
      job.cancelled = true;
    },
    resolve: (result: OfflineJobResult) => settle.resolve(result),
    reject: (error: unknown) => settle.reject(error),
  } as unknown as FakeJob;

  const start = jest.fn(() => job);
  const processor = {
    isSupported: overrides.isSupported ?? true,
    start,
  } as unknown as OfflineVideoProcessor;

  return { processor, job, start };
}

describe('processVideoBackground', () => {
  beforeEach(() => {
    resetOfflineProcessorCache();
    hasHybridObject.mockReset();
    createHybridObject.mockReset();
  });

  it('reports unsupported when the native processor is not linked', () => {
    hasHybridObject.mockReturnValue(false);
    expect(isOfflineBakeSupported()).toBe(false);
  });

  it('rejects with code "unsupported" rather than a raw error', async () => {
    hasHybridObject.mockReturnValue(false);
    await expect(
      processVideoBackground({ inputPath: '/tmp/in.mp4', background: BACKGROUND }),
    ).rejects.toMatchObject({ name: 'BackgroundFilterError', code: 'unsupported' });
  });

  it('rejects when the processor exists but reports no support', async () => {
    const { processor } = fakeProcessor({ isSupported: false });
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(processor);
    await expect(
      processVideoBackground({ inputPath: '/tmp/in.mp4', background: BACKGROUND }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('defaults the output path to a "-baked.mp4" sibling', async () => {
    const { processor, job, start } = fakeProcessor();
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(processor);

    const promise = processVideoBackground({
      inputPath: '/tmp/clip-trimmed.mov',
      background: BACKGROUND,
    });
    job.resolve({ outputPath: '/tmp/clip-trimmed-baked.mp4', durationMs: 1200 });
    await expect(promise).resolves.toEqual({
      outputPath: '/tmp/clip-trimmed-baked.mp4',
      durationMs: 1200,
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: '/tmp/clip-trimmed-baked.mp4' }),
    );
  });

  it('passes fit and mirror through, defaulting to cover and unmirrored', async () => {
    const { processor, job, start } = fakeProcessor();
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(processor);

    const promise = processVideoBackground({ inputPath: '/tmp/in.mp4', background: BACKGROUND });
    job.resolve({ outputPath: '/tmp/in-baked.mp4', durationMs: 1 });
    await promise;

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        background: { uri: 'file:///bg1.jpg', fit: 'cover', mirror: false },
        maxOutputHeight: 0,
      }),
    );
  });

  it('wires the progress callback and detaches it when finished', async () => {
    const { processor, job } = fakeProcessor();
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(processor);
    const onProgress = jest.fn();

    const promise = processVideoBackground({
      inputPath: '/tmp/in.mp4',
      background: BACKGROUND,
      onProgress,
    });
    expect(job.progressCallback).toBe(onProgress);
    job.progressCallback?.(0.5);
    expect(onProgress).toHaveBeenCalledWith(0.5);

    job.resolve({ outputPath: '/tmp/in-baked.mp4', durationMs: 1 });
    await promise;
    expect(job.progressCallback).toBeUndefined();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const { processor, start } = fakeProcessor();
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(processor);
    const controller = new AbortController();
    controller.abort();

    await expect(
      processVideoBackground({
        inputPath: '/tmp/in.mp4',
        background: BACKGROUND,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(start).not.toHaveBeenCalled();
  });

  it('cancels the native job when the signal aborts mid-bake', async () => {
    const { processor, job } = fakeProcessor();
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(processor);
    const controller = new AbortController();

    const promise = processVideoBackground({
      inputPath: '/tmp/in.mp4',
      background: BACKGROUND,
      signal: controller.signal,
    });
    controller.abort();
    expect(job.cancelled).toBe(true);

    job.reject(new Error('cancelled natively'));
    await expect(promise).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('maps an unknown native failure to code "encode-failed"', async () => {
    const { processor, job } = fakeProcessor();
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(processor);

    const promise = processVideoBackground({ inputPath: '/tmp/in.mp4', background: BACKGROUND });
    job.reject(new Error('MediaCodec died'));
    await expect(promise).rejects.toMatchObject({
      code: 'encode-failed',
      message: 'MediaCodec died',
    });
  });

  it('preserves a BackgroundFilterError thrown natively', async () => {
    const { processor, job } = fakeProcessor();
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(processor);

    const promise = processVideoBackground({ inputPath: '/tmp/in.mp4', background: BACKGROUND });
    job.reject(new BackgroundFilterError('decode-failed', 'bad input'));
    await expect(promise).rejects.toMatchObject({ code: 'decode-failed', message: 'bad input' });
  });

  it('fails fast on a background with no resolvable URI', async () => {
    const { processor, start } = fakeProcessor();
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(processor);

    await expect(
      processVideoBackground({
        inputPath: '/tmp/in.mp4',
        // An SkImage-shaped source has no URI for the native side to decode.
        background: { id: 'sk', source: { width: () => 1 } as never },
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(start).not.toHaveBeenCalled();
  });
});
