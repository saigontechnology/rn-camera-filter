/**
 * The unfiltered fallback surface, backed by `expo-camera`.
 *
 * **Behind its own subpath export (`…/surfaces/expo-camera`) on purpose.**
 * Importing it is what pulls `expo-camera` into the bundle; a consumer that
 * already has its own unfiltered camera never needs the dependency. See
 * `host/optionalRequire` for why a try/catch could not have made it optional.
 *
 * Why ship it at all, in a package about compositing? Because the capability gate
 * has two outcomes, and a consumer has to render *something* on a device that
 * cannot segment. Implementing the same {@link CameraSurfaceHandle} for both means
 * that choice is one ternary rather than a duplicated record screen:
 *
 * ```tsx
 * const Surface = isBackgroundFilterAvailable() ? VisionCameraSurface : ExpoCameraSurface;
 * ```
 *
 * Deliberately no background handling: `expo-camera` has no frame access, which is
 * the entire reason {@link VisionCameraSurface} exists. `backgroundId` and
 * `backgrounds` are accepted and ignored so the same props spread onto either.
 */
import React, { forwardRef, useImperativeHandle, useRef } from 'react';

import { StyleSheet } from 'react-native';

import { CameraView } from 'expo-camera';

import type { CameraSurfaceHandle, CameraSurfaceProps } from './CameraSurface';

export const ExpoCameraSurface = forwardRef<CameraSurfaceHandle, CameraSurfaceProps>(
  ({ facing, onReady, style }, ref) => {
    const cameraRef = useRef<CameraView>(null);

    useImperativeHandle(
      ref,
      () => ({
        record: async (maxDurationSec) => {
          const result = await cameraRef.current?.recordAsync({ maxDuration: maxDurationSec });
          // Never composited: this surface has no frame access at all.
          return result?.uri == null ? undefined : { uri: result.uri, hasBackground: false };
        },
        stop: () => {
          try {
            cameraRef.current?.stopRecording();
          } catch {
            // The session may already be torn down — nothing left to stop.
          }
        },
      }),
      [],
    );

    return (
      <CameraView
        ref={cameraRef}
        style={style ?? StyleSheet.absoluteFill}
        facing={facing}
        mode="video"
        onCameraReady={onReady}
      />
    );
  },
);

ExpoCameraSurface.displayName = 'ExpoCameraSurface';
