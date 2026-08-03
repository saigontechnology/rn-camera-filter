/**
 * The host-supplied capabilities this package needs but deliberately does not own.
 *
 * Everything here is something a React Native app already has, in a form that
 * varies per app: Expo apps get their cache directory from `expo-file-system`,
 * bare apps from `react-native-fs` or a native module of their own. Depending on
 * any one of them directly would force that choice on every consumer and put a
 * hard peer dependency in a package whose actual job is camera compositing.
 *
 * So they cross the boundary as plain functions. See `configureBackgroundFilterHost`
 * for how to supply them, and `adapters/expo` for a ready-made implementation.
 */

/**
 * The bits of a filesystem the record-time capture needs: somewhere to put the
 * intermediate files, and a way to delete them afterwards.
 *
 * The capture writes two temporary files per take (the composited video and the
 * remux result) and hands the caller every path it creates, so a host that
 * supplies this is never surprised by a file it did not hear about.
 */
export interface BackgroundFilterFileSystem {
  /**
   * Absolute path to a writable scratch directory, with a trailing slash and
   * **no URI scheme**.
   *
   * Plain path, not `file://…`, on purpose: Android's `MediaMuxer` rejects a URI
   * outright. Passing one here once cost a whole device run — the capture failed,
   * silently fell back to the offline bake, and looked like the device could not
   * capture at all. `createExpoBackgroundFilterHost` strips the scheme for you.
   *
   * `null` disables the record-time capture; the consumer falls back to baking.
   */
  cacheDirectory: string | null;

  /**
   * Best-effort delete of a file this package created.
   *
   * Must not throw and must not reject — it is called from cleanup paths that
   * have nothing useful to do with a failure, including after an error has
   * already been raised. Deleting a path that no longer exists is a no-op, not an
   * error.
   */
  deleteFile: (path: string) => void;
}

/**
 * Everything the package asks of its host.
 *
 * Supply it once with `configureBackgroundFilterHost`, or per-component through
 * the `host` prop on a camera surface. Every field is independently optional —
 * whatever is left out falls back to a safe default (no cache directory, no-op
 * delete, silent warnings).
 */
export interface BackgroundFilterHost {
  fileSystem: BackgroundFilterFileSystem;

  /**
   * Where the package reports a non-fatal problem.
   *
   * The package renders no copy and logs nothing of its own, so without this a
   * degraded path — a capture that could not start and quietly fell back to the
   * bake — is indistinguishable from a device that never supported it. That
   * distinction is the first thing worth knowing when a filtered recording comes
   * out wrong, so wire this to your logger.
   *
   * Never called for conditions the caller already learns about by other means;
   * only for the ones this package would otherwise swallow.
   */
  onWarn: (message: string, error?: unknown) => void;
}
