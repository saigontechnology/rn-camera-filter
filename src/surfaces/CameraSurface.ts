import type { StyleProp, ViewStyle } from 'react-native';

import type { BackgroundFilterHost } from '../host/types';
import type { BackgroundSource } from '../types';

/**
 * The contract shared by every camera surface in this package.
 *
 * A surface knows two things: how to show a preview, and how to produce a file.
 * Everything else a record screen does — countdown, elapsed timing, minimum
 * duration gates, teleprompters, permissions, the rule for discarding an
 * interrupted take — stays with the screen. That split is the point: it lets a
 * consumer swap the filtered camera in behind a capability check without
 * duplicating a screen per camera stack.
 *
 * Two implementations ship:
 * - {@link VisionCameraSurface} — VisionCamera 5, with live compositing and
 *   record-time capture.
 * - `ExpoCameraSurface` (subpath `…/surfaces/expo-camera`) — the unfiltered
 *   fallback for devices that cannot segment.
 */
export interface CameraRecording {
  /** Path or URI of the recorded file. */
  uri: string;
  /**
   * Whether the selected background is **already composited into this file**.
   *
   * True only when the record-time capture ran and completed: the encoder was fed
   * the same composite the preview drew. False means the file is the raw camera
   * feed, and a selected background still has to be baked in before it is
   * delivered.
   *
   * It describes the FILE, never the user's intent — a capture that failed and
   * fell back to the raw recording reports `false` even though a background was
   * selected. Branch on it and the fallback is safe; branch on the selection
   * instead and a failed capture uploads a clip missing its background.
   */
  hasBackground: boolean;
}

export interface CameraSurfaceHandle {
  /**
   * Starts recording, resolving once it stops — whether by {@link stop} or by
   * reaching `maxDurationSec`.
   *
   * Resolves `undefined` when the capture produced no usable file, e.g. the
   * session was torn down mid-take. Rejects only on a genuine capture failure.
   *
   * Callers must distinguish the two: on iOS, tearing the session down (the user
   * navigating back mid-record) **rejects** this promise, and treating that as a
   * failure puts a stray error toast on whatever screen they landed on.
   */
  record: (maxDurationSec: number) => Promise<CameraRecording | undefined>;

  /**
   * Requests a stop.
   *
   * Must be safe to call when not recording, and after the session is already
   * gone — consumers call it from unmount cleanup.
   */
  stop: () => void;
}

export interface CameraSurfaceProps {
  facing: 'front' | 'back';
  /** Fired once the preview is live. Gate your start control on it. */
  onReady: () => void;
  style?: StyleProp<ViewStyle>;
  /**
   * Selected background id; `undefined` or `'none'` for no filter.
   *
   * Ignored by surfaces that cannot composite, so the same props can be spread
   * onto whichever surface the capability check picked.
   */
  backgroundId?: string;
  /**
   * The selectable backgrounds. Defaults to the package's bundled set.
   *
   * Injecting **replaces** the defaults rather than appending — spread
   * `DEFAULT_BACKGROUNDS` in if you want both.
   */
  backgrounds?: readonly BackgroundSource[];
  /**
   * Per-mount override of the host capabilities, taking precedence over anything
   * `configureBackgroundFilterHost` registered.
   *
   * Most apps configure once at startup and never pass this. It exists for tests,
   * and for a screen that needs its own scratch directory.
   *
   * Pass a stable reference — it is a memo dependency, so an object literal
   * rebuilt every render defeats the memoisation.
   */
  host?: Partial<BackgroundFilterHost>;
}
