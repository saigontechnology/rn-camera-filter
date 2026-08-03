import { useMemo } from 'react';

import type { BackgroundFilterFileSystem, BackgroundFilterHost } from './types';

/**
 * The default filesystem: no scratch directory, deletes nothing.
 *
 * Chosen so an unconfigured host **degrades rather than breaks**. With no cache
 * directory the record-time capture does not start, the raw recording is handed
 * on with `hasBackground: false`, and the consumer's offline bake puts the
 * background in exactly as it would on a device that could not capture. The user
 * still gets the clip they recorded; they just wait for it.
 */
export const NULL_FILE_SYSTEM: BackgroundFilterFileSystem = {
  cacheDirectory: null,
  deleteFile: () => undefined,
};

const NULL_HOST: BackgroundFilterHost = {
  fileSystem: NULL_FILE_SYSTEM,
  onWarn: () => undefined,
};

let configured: Partial<BackgroundFilterHost> = {};

/**
 * Registers the host capabilities this package needs, process-wide.
 *
 * Call it once during app startup, before a camera surface mounts. Calling it
 * again merges — passing only `onWarn` leaves a previously configured
 * `fileSystem` alone — so independent concerns can be wired from separate places
 * without one clobbering the other.
 *
 * @example
 * // App entry point
 * import { configureBackgroundFilterHost } from '@saigontechnology/vision-camera-background-filter';
 * import { createExpoBackgroundFilterHost } from '@saigontechnology/vision-camera-background-filter/adapters/expo';
 *
 * configureBackgroundFilterHost({
 *   ...createExpoBackgroundFilterHost(),
 *   onWarn: (message, error) => log.warn(message, error),
 * });
 */
export function configureBackgroundFilterHost(host: Partial<BackgroundFilterHost>): void {
  configured = { ...configured, ...host };
}

/** Clears everything `configureBackgroundFilterHost` registered. Test seam. */
export function resetBackgroundFilterHost(): void {
  configured = {};
}

/**
 * The effective host: per-call overrides first, then whatever was configured
 * globally, then the null defaults.
 *
 * Resolved field by field rather than object by object, so a caller passing just
 * `{ onWarn }` still gets the configured filesystem.
 */
export function resolveBackgroundFilterHost(
  overrides?: Partial<BackgroundFilterHost>,
): BackgroundFilterHost {
  return {
    fileSystem: overrides?.fileSystem ?? configured.fileSystem ?? NULL_HOST.fileSystem,
    onWarn: overrides?.onWarn ?? configured.onWarn ?? NULL_HOST.onWarn,
  };
}

/**
 * {@link resolveBackgroundFilterHost} for components.
 *
 * Memoised on the override identity so a surface's imperative handle is not
 * rebuilt every render. Note it does **not** subscribe to
 * `configureBackgroundFilterHost` — configuration is expected once at startup,
 * and a host that changed mid-session would swap the filesystem out from under an
 * in-flight capture.
 */
export function useBackgroundFilterHost(
  overrides?: Partial<BackgroundFilterHost>,
): BackgroundFilterHost {
  // Destructured so the memo depends on the two FIELDS rather than on the
  // `overrides` object. Depending on the object would rebuild the host — and with
  // it the surface's imperative handle — on every render for the common case of a
  // caller passing an inline literal.
  const fileSystem = overrides?.fileSystem;
  const onWarn = overrides?.onWarn;

  return useMemo(() => resolveBackgroundFilterHost({ fileSystem, onWarn }), [fileSystem, onWarn]);
}
