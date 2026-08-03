/**
 * A ready-made {@link BackgroundFilterHost} backed by `expo-file-system`.
 *
 * **This module is behind its own subpath export on purpose.** Importing it is
 * what pulls `expo-file-system` into the bundle, so a consumer that does not use
 * it never needs the dependency installed — see `host/optionalRequire` for why a
 * try/catch around the import would not have achieved that.
 *
 * ```ts
 * import { configureBackgroundFilterHost } from '@saigontechnology/vision-camera-background-filter';
 * import { createExpoBackgroundFilterHost } from '@saigontechnology/vision-camera-background-filter/adapters/expo';
 *
 * configureBackgroundFilterHost(createExpoBackgroundFilterHost());
 * ```
 *
 * Not using Expo? Implement `BackgroundFilterFileSystem` against whatever you do
 * have — it is two members — and pass it to `configureBackgroundFilterHost`
 * directly. Nothing about this package assumes Expo.
 */
import { optionalRequire } from '../host/optionalRequire';

import type { BackgroundFilterFileSystem, BackgroundFilterHost } from '../host/types';

/**
 * The slice of `expo-file-system/legacy` used here.
 *
 * The legacy entry point rather than the current one because it is the one that
 * still exposes `cacheDirectory` as a plain value. Typed structurally so this
 * adapter is not pinned to a single `expo-file-system` major.
 */
interface ExpoFileSystemModule {
  cacheDirectory?: string | null;
  deleteAsync?: (uri: string, options?: { idempotent?: boolean }) => Promise<void>;
}

/**
 * `expo-file-system` hands back `file:///…` URIs, but native muxers want a plain
 * path — Android's `MediaMuxer` rejects a URI outright. Normalised once, here, so
 * no caller has to remember which of the two forms it is holding.
 */
const stripScheme = (uri: string): string => uri.replace(/^file:\/\//, '');

/** …and the inverse, because `deleteAsync` requires the scheme it gave us. */
const withScheme = (path: string): string => (path.startsWith('file://') ? path : `file://${path}`);

export interface ExpoBackgroundFilterHostOptions {
  /**
   * Where a non-fatal problem is reported. Defaults to `console.warn`.
   *
   * The package itself never logs — it has no opinion on your logging — but an
   * adapter is host-side code, so a sane default belongs here rather than
   * nowhere. Pass your own logger to route it properly, or `() => {}` to silence
   * it.
   */
  onWarn?: BackgroundFilterHost['onWarn'];
}

/**
 * Builds the filesystem half of the host from `expo-file-system`.
 *
 * Degrades to {@link NULL_FILE_SYSTEM} semantics if the module is present but
 * unusable (autolinking did not run, or the platform has no filesystem): a null
 * `cacheDirectory` turns the record-time capture off and the consumer's offline
 * bake takes over, which is a slower path to the same clip rather than a failure.
 */
export function createExpoFileSystem(): BackgroundFilterFileSystem {
  const fs = optionalRequire<ExpoFileSystemModule>(() =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('expo-file-system/legacy'),
  );

  const cacheDirectory = fs?.cacheDirectory != null ? stripScheme(fs.cacheDirectory) : null;
  const deleteAsync = fs?.deleteAsync;

  return {
    cacheDirectory,
    deleteFile: (path) => {
      if (deleteAsync == null) return;
      // Fire-and-forget with the rejection swallowed: this runs from cleanup
      // paths, including ones already unwinding an error, and a file that is
      // already gone is the expected case rather than a problem. `idempotent`
      // covers the missing-file case natively; the catch covers the rest.
      void deleteAsync(withScheme(path), { idempotent: true }).catch(() => undefined);
    },
  };
}

/**
 * The full Expo host: {@link createExpoFileSystem} plus a `console.warn` logger.
 *
 * Spread it to override a piece:
 * ```ts
 * configureBackgroundFilterHost({ ...createExpoBackgroundFilterHost(), onWarn: log.warn });
 * ```
 */
export function createExpoBackgroundFilterHost(
  options: ExpoBackgroundFilterHostOptions = {},
): BackgroundFilterHost {
  return {
    fileSystem: createExpoFileSystem(),
    onWarn:
      options.onWarn ??
      ((message, error) => {
        console.warn(`[background-filter] ${message}`, error);
      }),
  };
}
