import React, { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';

import { Platform, StyleSheet, View } from 'react-native';

import { Camera, useVideoOutput } from 'react-native-vision-camera';

import { DEFAULT_BACKGROUNDS } from '../assets/background';
import { BACKGROUND_NONE } from '../backgrounds/registry';
import { isCompositeCaptureSupported, startCompositeCapture } from '../capture/compositeCapture';
import { useBackgroundFilter } from '../hooks/useBackgroundFilter';
import { useBackgroundFilterHost } from '../host/host';
import { BackgroundRendererView } from '../views/BackgroundRendererView';

import type { CompositeCapture } from '../capture/compositeCapture';
import type { BackgroundEffect } from '../types';
import type { CameraSurfaceHandle, CameraSurfaceProps } from './CameraSurface';
import type { Recorder } from 'react-native-vision-camera';

/**
 * The VisionCamera 5 camera surface, with live background compositing.
 *
 * Two outputs run in parallel: `CameraVideoOutput` records the raw feed, and
 * `CameraFrameOutput` feeds the compositor that draws what the user sees. VC5
 * offers no route from a composited frame into its `Recorder`, so a recording made
 * with a background needs the two halves joined:
 *
 * ```
 * CameraFrameOutput ─► compositor ─► preview
 *                                 └► composite encoder ─► composite.mp4 (video, no audio)
 * CameraVideoOutput ─► Recorder ───────────────────────► raw.mp4       (audio, no background)
 *                                                        └─ remux ─► the delivered clip
 * ```
 *
 * The remux copies both tracks without re-encoding, so it takes about a second and
 * nothing here owns A/V sync. The clip that comes out is the composite the user
 * watched — no bake, and no wait at submit time.
 *
 * When the capture cannot run (no host filesystem, unsupported device, encoder
 * failure) the raw recording is handed on instead, flagged `hasBackground: false`,
 * so the consumer bakes the background in afterwards. The take is never lost.
 *
 * ### Host requirements
 *
 * Recording composited clips needs a scratch directory and a way to delete
 * temporary files. Supply them once via `configureBackgroundFilterHost`, or per
 * mount via the `host` prop. Without them this still previews the filter — only
 * the record-time capture is skipped.
 */

/**
 * Portrait 9:16 — the shape VisionCamera's recorder negotiates for its video output
 * (measured `720x1280` on a Galaxy S22), and what a typical unfiltered camera
 * records. The composite capture is cropped to it so turning the filter on does not
 * change the shape of the delivered clip.
 */
const RECORDING_ASPECT_RATIO = 9 / 16;

/** Joins a directory and a filename without doubling or dropping the separator. */
const joinPath = (directory: string, name: string): string =>
  directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;

export const VisionCameraSurface = forwardRef<CameraSurfaceHandle, CameraSurfaceProps>(
  ({ facing, onReady, style, backgroundId, backgrounds = DEFAULT_BACKGROUNDS, host }, ref) => {
    const { fileSystem, onWarn } = useBackgroundFilterHost(host);

    const videoOutput = useVideoOutput({
      // The clip carries the user's audio, so this is required. The consumer has
      // already gated on the microphone permission.
      enableAudio: true,
      // 'mov' ON iOS, and the extension is the whole point.
      //
      // `AVCaptureMovieFileOutput` writes a QuickTime container no matter what is
      // asked of it, so `'mp4'` produced a QuickTime file NAMED `.mp4`. `AVURLAsset`
      // picks its parser from the extension, so the MP4 parser read the HEVC video
      // track and silently DISCARDED the QuickTime-style audio sample entry — every
      // AVFoundation consumer downstream then saw a file with no audio. Verified on
      // the real file: opened as `.mp4` it reports 0 audio tracks, the same bytes
      // renamed `.mov` report 1.
      //
      // That cost a silent, audio-less delivery on iOS through BOTH the remux and the
      // offline bake. Android is unaffected — `MediaExtractor` sniffs the content
      // rather than trusting the name — and its muxer wants a real MP4.
      fileType: Platform.OS === 'ios' ? 'mov' : 'mp4',
    });

    const effect = useMemo<BackgroundEffect>(
      () =>
        backgroundId == null || backgroundId === BACKGROUND_NONE
          ? { kind: 'none' }
          : { kind: 'image', id: backgroundId },
      [backgroundId],
    );

    const backgroundList = useMemo(() => [...backgrounds], [backgrounds]);

    const { frameOutput, renderer } = useBackgroundFilter({
      effect,
      backgrounds: backgroundList,
      fit: 'cover',
      // The BACKGROUND is never mirrored, on either camera: mirroring it would flip
      // it against the person, and would make it differ between the preview and the
      // unmirrored file the bake produces. Keeping it unmirrored in both paths is
      // what gives background parity.
      mirror: false,
      // The CAMERA is mirrored on the front camera, so the filtered preview matches
      // the unfiltered one — every selfie preview is mirrored, and the raw
      // VisionCamera preview this replaces is too. Without it, switching the filter
      // on flips the subject left-to-right. The recorded file stays unmirrored.
      mirrorCamera: facing === 'front',
    });

    const recorderRef = useRef<Recorder | null>(null);
    /**
     * The in-flight capture, so {@link stop} can stop the encoder at the same instant
     * it stops the recorder.
     *
     * Stopping it later — when the recorder's file finally arrives, hundreds of
     * milliseconds after the stop was requested — would leave the video longer than
     * the audio at the TAIL, and the remux infers the head offset from the difference
     * between the two durations. A loose tail corrupts that inference.
     */
    const captureRef = useRef<CompositeCapture | null>(null);

    useImperativeHandle(
      ref,
      () => ({
        record: async (maxDurationSec) => {
          // `maxDuration` is in seconds and finalises the file exactly like an
          // explicit stop, which is what replaces a manual auto-stop.
          const recorder = await videoOutput.createRecorder({ maxDuration: maxDurationSec });
          recorderRef.current = recorder;

          // Start the camera's recorder FIRST and wait until it is actually
          // recording — `startRecording`'s promise resolves at that moment, which is
          // the only anchor either side offers.
          //
          // ORDER MATTERS FOR LIP SYNC. The composite encoder takes its t=0 from its
          // own first frame. Start it before the recorder and the audio muxed in
          // belongs to a moment the video does not have, so it runs ahead — measured
          // at 370 ms on the first device run. Start it after, and the audio is
          // instead LONGER at the head by exactly that gap, which `muxAudio` removes
          // by comparing the two durations. The cost is at most one frame at the very
          // start of the take.
          let started: Promise<void> | undefined;
          const finished = new Promise<string | undefined>((resolve, reject) => {
            started = recorder.startRecording(
              (filePath) => resolve(filePath),
              (error) => reject(error),
            );
            started.catch(reject);
          });
          await started;

          // Now record the composite the user is watching, alongside the recorder.
          // One take, two files: ours has the background and no audio, VisionCamera's
          // has the audio and no background, and the remux joins them.
          //
          // A failure here is not fatal — the raw recording still happens and the
          // consumer bakes the background in afterwards.
          const cacheDir = fileSystem.cacheDirectory;

          let capture: CompositeCapture | null = null;
          if (
            renderer != null &&
            cacheDir != null &&
            effect.kind === 'image' &&
            isCompositeCaptureSupported(renderer)
          ) {
            try {
              capture = startCompositeCapture({
                renderer,
                outputPath: joinPath(cacheDir, `composite-${Date.now()}.mp4`),
                // Matches the recorder's own target; the frame output is
                // preview-sized, so this is a ceiling, not an upscale.
                maxOutputHeight: 1920,
                // The frames we composite are shaped for the PREVIEW (4:3, so the
                // filtered preview shows the same field of view as the unfiltered
                // one), but the camera's own recorder writes 9:16 — measured
                // 720x1280 on a Galaxy S22. Without this the filtered clip would be
                // a different shape than an unfiltered one, which every downstream
                // consumer of the file sees.
                aspectRatio: RECORDING_ASPECT_RATIO,
              });
            } catch (e) {
              // Without this the host cannot tell a failed capture from a device
              // that never supported one. It is not fatal (the bake still runs),
              // but it IS the thing to look at first when a filtered clip comes
              // back unfiltered.
              onWarn('capture could not start; falling back to the offline bake', e);
              capture = null;
            }
          }

          captureRef.current = capture;

          let rawPath: string | undefined;
          try {
            rawPath = await finished;
          } catch (e) {
            // The recorder failed or the session was torn down (Back mid-record on
            // iOS rejects here). Our encoder is independent of it and would
            // otherwise keep running against a dead camera, holding a file nobody
            // can reach — the caller never learns its path on this path.
            if (capture != null) {
              const partial = await capture.cancel();
              if (partial != null) fileSystem.deleteFile(partial);
            }
            throw e;
          } finally {
            captureRef.current = null;
          }

          if (capture == null) {
            return rawPath == null ? undefined : { uri: rawPath, hasBackground: false };
          }

          // No raw file means the session died mid-take; the composite alone has
          // no audio, so the clip is discarded rather than delivered mute.
          if (rawPath == null) {
            const partial = await capture.cancel();
            if (partial != null) fileSystem.deleteFile(partial);
            return undefined;
          }

          try {
            const { outputPath, capturePath } = await capture.finish({
              audioSourcePath: rawPath,
            });
            // Both inputs are consumed by the mux; only the result is handed on.
            fileSystem.deleteFile(capturePath);
            fileSystem.deleteFile(rawPath);
            return { uri: outputPath, hasBackground: true };
          } catch (e) {
            // Fall back to the unfiltered recording rather than losing the take.
            // Reporting `hasBackground: false` is what makes that safe: the
            // consumer sees a raw clip and bakes the background in, so the user
            // still gets what they recorded — just with the wait.
            onWarn('capture failed; falling back to the offline bake', e);
            return { uri: rawPath, hasBackground: false };
          }
        },
        stop: () => {
          // Both stops go out together, so the two tracks end at the same instant —
          // see `captureRef`. The encoder's own stop is idempotent, so the mux below
          // can call it again without consequence.
          //
          // Fire-and-forget: the promise from `record` is what reports the result,
          // and a rejection here would be an unhandled one. A stop on a dead
          // session is expected during unmount teardown.
          recorderRef.current?.stopRecording().catch(() => undefined);
          captureRef.current?.stop().catch(() => undefined);
        },
      }),
      [videoOutput, renderer, effect, fileSystem, onWarn],
    );

    const outputs = useMemo(
      () => (frameOutput != null ? [videoOutput, frameOutput] : [videoOutput]),
      [videoOutput, frameOutput],
    );

    return (
      <View style={style ?? StyleSheet.absoluteFill}>
        <Camera
          isActive
          device={facing}
          outputs={outputs}
          style={StyleSheet.absoluteFill}
          onStarted={onReady}
        />
        {/* Mounted only while filtering: with no frames arriving it would draw a
            blank rectangle over the live preview instead of the camera. */}
        {renderer != null ? (
          <BackgroundRendererView style={StyleSheet.absoluteFill} renderer={renderer} />
        ) : null}
      </View>
    );
  },
);

VisionCameraSurface.displayName = 'VisionCameraSurface';
