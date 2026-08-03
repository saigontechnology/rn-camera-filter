import {
  NULL_FILE_SYSTEM,
  configureBackgroundFilterHost,
  resetBackgroundFilterHost,
  resolveBackgroundFilterHost,
} from './host';

import type { BackgroundFilterFileSystem } from './types';

const fsA: BackgroundFilterFileSystem = { cacheDirectory: '/a/', deleteFile: jest.fn() };
const fsB: BackgroundFilterFileSystem = { cacheDirectory: '/b/', deleteFile: jest.fn() };

beforeEach(resetBackgroundFilterHost);

describe('resolveBackgroundFilterHost', () => {
  // The unconfigured case is the one that must not throw: it is what a consumer
  // gets before wiring anything, and it has to degrade to "no capture, bake
  // instead" rather than break the camera screen.
  it('falls back to a null host when nothing is configured', () => {
    const host = resolveBackgroundFilterHost();
    expect(host.fileSystem).toEqual(NULL_FILE_SYSTEM);
    expect(() => host.onWarn('anything')).not.toThrow();
    expect(() => host.fileSystem.deleteFile('/tmp/x')).not.toThrow();
  });

  it('uses what was configured', () => {
    configureBackgroundFilterHost({ fileSystem: fsA });
    expect(resolveBackgroundFilterHost().fileSystem).toBe(fsA);
  });

  // Merging, not replacing: `onWarn` and `fileSystem` are wired from different
  // places in a real app, and the second call must not silently drop the first.
  it('merges successive calls instead of replacing', () => {
    const onWarn = jest.fn();
    configureBackgroundFilterHost({ fileSystem: fsA });
    configureBackgroundFilterHost({ onWarn });

    const host = resolveBackgroundFilterHost();
    expect(host.fileSystem).toBe(fsA);
    expect(host.onWarn).toBe(onWarn);
  });

  it('lets a per-call override win', () => {
    configureBackgroundFilterHost({ fileSystem: fsA });
    expect(resolveBackgroundFilterHost({ fileSystem: fsB }).fileSystem).toBe(fsB);
  });

  // Field-by-field, not object-by-object — a caller overriding only `onWarn`
  // must keep the configured filesystem rather than silently losing it.
  it('resolves each field independently', () => {
    const onWarn = jest.fn();
    configureBackgroundFilterHost({ fileSystem: fsA });

    const host = resolveBackgroundFilterHost({ onWarn });
    expect(host.onWarn).toBe(onWarn);
    expect(host.fileSystem).toBe(fsA);
  });

  it('is cleared by reset', () => {
    configureBackgroundFilterHost({ fileSystem: fsA });
    resetBackgroundFilterHost();
    expect(resolveBackgroundFilterHost().fileSystem).toEqual(NULL_FILE_SYSTEM);
  });
});
