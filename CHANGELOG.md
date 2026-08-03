# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the package is
pre-1.0 and unpublished, so the surface may still change without a major bump.

## [Unreleased]

### Added — record-time capture (records the composite the user is watching)

- **`startCompositeCapture()` / `isCompositeCaptureSupported()`** — record the
  composited frames as they are previewed, instead of recording the raw feed and
  baking the background in afterwards. The delivered clip is written from the same
  composite that reached the screen, so there is no second segmentation pass, no
  wait before the file is ready, and no way for the preview and the upload to
  disagree about framing, mask, or background.
- **`BackgroundRenderer.startCapture()` / `.stopCapture()` / `.isCaptureSupported`** —
  the native half. The encoder is fed from inside `renderFrame`, one draw after the
  preview:
  - iOS — `AVAssetWriter` + a pixel-buffer adaptor, fed the composited `CIImage`.
  - Android — a second EGL window surface over `MediaCodec`'s input `Surface`,
    sharing the renderer's context so the frame's textures are already resident.
    `CompositeGl` gained `uploadFrame`/`drawUploaded` for exactly this: the capture
    costs a draw call, not a second CPU-side plane upload.
- **`OfflineVideoProcessor.muxAudio()`** — the other half. A capture is video-only,
  because the microphone belongs to the camera session; VisionCamera's own
  `Recorder` runs alongside it and its audio track is remuxed onto the composited
  video. **Neither track is re-encoded** (iOS: `AVMutableComposition` exported
  passthrough; Android: `MediaExtractor` → `MediaMuxer` sample copy), so this costs
  about a second on a 30 s clip and no code here owns A/V sync — the same argument
  that made the offline bake safe.
- The recording is composited **unmirrored, and cropped to the recorder's own aspect**
  — matching what the offline bake produced and what a camera records without the
  filter — while the preview stays mirrored and cover-cropped to the view. Two draws of
  one composite, with different geometry each. On iOS the unmirrored variant costs a
  second `CIBlendWithMask` per frame on the front camera; segmentation, the expensive
  part, still runs once.
- The offline bake is **not** removed: it is the fallback for a device that cannot
  capture, for an encoder that fails mid-take, and for clips that arrive from the
  gallery rather than the camera.

#### Fixed — the filtered preview was zoomed in relative to the unfiltered one

Reported from the device: with `none` the subject looked normal, and the moment a
background was selected it jumped closer and bigger. **Not a scaling bug — the filter
was compositing a narrower slice of the scene.**

`useFrameOutput` defaults `targetResolution` to `CommonResolutions.HD_16_9`, and the
package never set it. Measured on a Galaxy S22:

| Stream                              | Negotiated | Portrait aspect |
| ----------------------------------- | ---------- | --------------- |
| `Preview` (what `none` shows)       | 1440x1080  | 0.75 (4:3)      |
| `ImageAnalysis` (what we composite) | 1280x720   | 0.5625 (16:9)   |

A 16:9 stream is a **crop** of the same 4:3 sensor area, so it starts with less field
of view; cover-cropping it into the same view then scales it up further. Two fixes:

- **`useBackgroundFilter` now defaults `targetResolution` to 4:3** (`HD_4_3`-shaped)
  and exposes it as an option. VisionCamera prioritizes the ratio over the pixel count,
  and `enablePreviewSizedOutputBuffers` still keeps the buffers small. Verified: the
  analysis stream is now `960x720`, matching the preview's aspect.
- **`startCapture` takes an `aspectRatio`**, because the frames are now shaped for the
  preview while the camera's recorder still writes 16:9 — left alone, a filtered clip
  would have come out 4:3 where an unfiltered one is 9:16. The capture centre-crops to
  it (Android via the GL pass's UV rect, iOS via a cover-crop before the writer), and
  iOS's `scaled(_:to:)` was fixed to cover-crop rather than scale each axis
  independently, which would have stretched the frame.

  Verified: the recorded file is `540x960`, aspect exactly 0.5625.

⚠️ **This costs delivered resolution: 720x1280 → 540x960.** The 4:3 preview-sized
buffer is 960 px on its long edge, and cropping to 9:16 takes width from it. To get
resolution back, a consumer must set `enablePreviewSizedOutputBuffers: false` and pay
for full-resolution frames in the realtime budget — FOV parity and cheap frames are in
direct tension here, and this trade was chosen for parity.

#### Fixed — Android: switching between two backgrounds kept showing the first

Reported from the device: selecting a background worked, selecting a **different** one
did nothing, and only a detour through `none` let the next choice take effect.

`applyPendingBackground` decoded the new bitmap but only called
`composite.clearBackground()` when the new background was `null`. That flag is what
`uploadPendingBitmap` checks to keep the texture upload off the per-frame path — so
with it still set, the new bitmap was never uploaded and the GPU kept the previous
texture. Going via `none` was the only path that cleared it, which is exactly the
workaround that was observed. It now clears on **every** change.

iOS was never affected: its compositor swaps the `CIImage` with no upload cache.

#### Fixed — Android: raising the frame resolution sheared the camera image

Raising the analysis stream past 960x720 turned the person into vertical colour
stripes while the background rendered perfectly and the mask silhouette stayed
correct — the signature of a texture-upload bug, not a segmentation one.

`CompositeGl` uploaded the Y and UV planes assuming `rowStride == width`.
`YUV_420_888` rows are padded to a hardware stride, and on a Galaxy S22 a 960x720
buffer is tightly packed while a 1280x960 one is not, so every row landed offset from
the one before. The whole stride is now uploaded as the texture width and the shader
samples only the image portion of it (`uYScale` / `uUvScale`, applied at lookup time
because the rotation must happen in image space and Y and UV can have different
strides). Row counts are clamped to what the buffer actually holds, since a plane is
often a byte or two short of `stride × rows`.

**The offline bake shared the bug** — same shader, same assumption, and a `MediaCodec`
decoder pads its rows too. Fixed at both call sites.

#### Measured — resolution vs frame rate (Galaxy S22, 2026-08-02)

Frame rate here is derived from the recording itself (encoded frames ÷ duration),
which is exact: the capture encodes one frame per frame delivered to the composite.

| `targetResolution` | Analysis stream | Recording | Galaxy S22 | iPhone 11         |
| ------------------ | --------------- | --------- | ---------- | ----------------- |
| preview-sized      | 960x720         | 540x960   | **29.89**  | —                 |
| **960x1280** ← set | 1440x1080       | 810x1440  | **29.88**  | not measured      |
| 1440x1920          | 1920x1440       | 1080x1920 | **22.16**  | **24.26 / 26.08** |

**The default is now `960x1280` on both platforms — an 810x1440 deliverable at ~30 fps.**
Full 1080p puts Android at 22.16, _under_ the ≥24 budget on a flagship, and iOS right on
it (24.26 on one run, 26.08 on another; the spread is thermal). The preview draws from
these same frames, so it is visible smoothness, not just a file property. 810x1440 still
beats the 720x1280 an unfiltered recording produces. If 1080p is ever required, make it
platform-conditional: iOS has the headroom, Android does not.

#### Fixed — iOS: the delivered clip had no audio, and the bake's video was corrupted

Both traced to **one** cause, and it was not in this package's muxing logic.

`AVCaptureMovieFileOutput` — what VisionCamera records with — **always writes a
QuickTime container**, even when asked for `mp4`. VisionCamera then names the file
`.mp4`. `AVURLAsset` picks its parser from the URL's **extension**, so AVFoundation
parsed a QuickTime file as MP4: it read the HEVC video track and **silently discarded
the QuickTime-style audio sample entry**. No error, no warning — just a file that
reports no audio. Proven against a real recording:

| Same bytes, opened as                | audio tracks |
| ------------------------------------ | ------------ |
| `.mp4` (as VisionCamera writes it)   | **0**        |
| renamed `.mov`                       | **1**        |
| `.mp4` + `video/quicktime` MIME hint | 0            |

The recording itself was always fine — 868 audio samples across 37 chunks, track
enabled, AAC stereo. Every AVFoundation consumer downstream lost it, which is why the
remux **and** the offline bake both produced silent clips, and the most likely reason
the baked picture came out corrupted as well. Android was never affected:
`MediaExtractor` sniffs the content instead of trusting the name.

- **Consumers must record as `'mov'` on iOS** so the name matches the container. The
  README and `startCompositeCapture` say so now.
- **Safety net in `muxAudio`:** an audio source that reports no audio track and is not
  already `.mov` is retried through a `.mov` **symlink** — free, where copying a 30 MB
  recording to rename it would not be.
- **A source with genuinely no audio now throws** instead of quietly shipping silence.
  Delivering a clip the user recorded with sound, muted, is data loss; failing routes
  it to the bake fallback where the consumer can see it.
- The mux also moved off the deprecated synchronous `asset.tracks` / `asset.duration`
  accessors to the async `loadTracks(withMediaType:)` / `load(.duration)` API.

Two wrong diagnoses preceded this one (a weak `AVAssetTrack.asset` reference, then the
sync-accessor deprecation), both plausible and both costing a device round trip. What
settled it was pulling the actual recording off the phone and reproducing against it in
a 40-line local harness — which should have been the second step, not the fourth.

#### Verified on a device (Galaxy S22, Android 15, 2026-08-02)

First real run of the capture path, and of **any** path that writes a background into
a file — the offline bake had never executed either. Both ran, in the same session.

- Record → Review with **no bake step at all**: the clip the user reviews is the one
  the encoder wrote. Output `720x1280`, identity display matrix (rotation baked into
  the pixels, so nothing rotates it twice on playback), video **and** audio tracks
  present, ~23 s. Playback is upright, unmirrored, with the background composited and
  the subject clean.
- Two bugs found, both fixed below. Neither was reachable by any static check.
- ✅ **A/V alignment, fixed and re-measured: +370 ms → +37 ms.** The first run had the
  audio running ahead of the picture. Three changes, all needed together:
  1. **The capture now starts after the recorder is actually recording.**
     `startRecording`'s promise resolves at that moment, which is the only anchor
     either side offers. Starting first meant the muxed audio belonged to a moment the
     video did not have. The cost is at most one frame at the very start of a take.
  2. **Both stops are issued together**, from the consumer's stop handler, instead of
     stopping the encoder when the recorder's file finally arrives hundreds of
     milliseconds later. `CompositeCapture.stop()` was split out of `finish()` for
     this and is idempotent, so the later mux reuses it.
  3. **`muxAudio` infers the head offset from the two durations and skips it** rather
     than writing audio from zero. With (1) and (2) the audio is longer only at the
     head, so the gap between the durations _is_ the offset — no clock, no guess.
     Android drops samples below it and rebases the rest; iOS inserts the audio time
     range from it.

  Re-measured on the same device: video 21.500 s, audio 21.463 s. The remaining 37 ms
  is video extending _past_ the audio, i.e. trailing silence, not a sync error — and
  it is inside the ~45 ms threshold where an audio lead becomes perceptible anyway.
  Note this makes the invariant load-bearing: **the capture must be contained within
  the recording.** `startCompositeCapture` and `CompositeCapture.stop` document it;
  break it and the inference silently degrades to the old offset-zero behaviour.

### Added

- Package scaffold as a Yarn workspace (`react-native-builder-bob` field layout, so
  dev-mode `source` resolution and published `main`/`module`/`types` cannot diverge).
- Public types: `BackgroundSource`, `BackgroundEffect`, `BackgroundFit`,
  `SegmentationSupport`.
- `BackgroundFilterError` with typed `code`s (`unsupported`, `decode-failed`,
  `encode-failed`, `cancelled`, `io`) as the package's only rejection type.
- `composite/geometry.ts` — the single source of fit/crop/mirror/rotation math shared
  by the live and offline composites, with 36 unit tests.
- `useSegmentationSupport()` / `getSegmentationSupport()` capability gate over the
  native `BackgroundRenderer` Nitro HybridObject, with 9 tests covering the
  native-absent, unsupported-device, and supported paths.
- `processVideoBackground()` — JS wrapper over the native offline processor, with
  progress, `AbortSignal` cancellation, and typed errors (12 tests).
- `resolveBackgroundUri()` — resolves a `require()`d asset or `{ uri }` to a URI the
  native side can decode.
- **Native selfie segmenter**, shared by the live and offline paths:
  - iOS — `VNGeneratePersonSegmentationRequest` behind a `VNSequenceRequestHandler`
    (kept warm across frames), `.balanced` live / `.accurate` offline, one-component-8
    mask output. iOS 15+, gated at runtime.
  - Android — MLKit `segmentation-selfie` in STREAM mode (live) / SINGLE_IMAGE mode
    (offline), raw-size masks so the upscale happens in the shader rather than on the
    CPU, with a 2s per-frame timeout so a wedged frame cannot stall the pipeline.
  - A frame that fails to segment returns no mask, and callers draw the frame
    unmodified rather than reusing a stale mask (which would smear the previous
    frame's silhouette).
- Build wiring: podspec, Android Gradle project, empty `AndroidManifest.xml` (no
  permissions — the host owns those), and a `BackgroundFilterPackage` so Android
  autolinking can discover the library. Both platforms verified discovered. (That
  package started out empty; see Fixed — it has to load the native library and
  register the renderer's ViewManager, or nothing works.)

### Changed

- **Renamed to `@saigontechnology/vision-camera-background-filter`** (was `@dossier/…`).
  This package is Saigon Technology's, not the client app's. The rename also moved the
  Android package to `com.saigontechnology.backgroundfilter` and the Gradle project to
  `:saigontechnology_vision-camera-background-filter`, and reassigned the LICENSE
  copyright. The host app remains `dossier-mobile` and keeps its own identity.
- **The live composite is native (Metal/GL), not Skia.** The originally planned route
  through VisionCamera's `FrameRenderer` is impossible — `renderFrame` accepts only a
  VisionCamera `Frame`, never a composited image. Shipping our own renderer instead
  lets the live and offline paths share one rasterizer per platform, which makes
  preview/output parity structural rather than something to test our way into.
- **Dropped the `@shopify/react-native-skia` peer dependency** as a consequence, and
  with it the measured 25 MB/ABI `librnskia.so`.
- `BackgroundSource.source` no longer accepts a pre-decoded `SkImage` — only a
  `require()`d asset or `{ uri }`. Backgrounds are decoded natively so the live and
  offline paths load them identically.
- Removed `useBackgroundImages()`; background decoding and texture residency are the
  native renderer's job now, not JS's.
- Removed the Expo config plugin. MLKit's selfie model is bundled-only, so its
  `bundleMlkitModel` option would have been fiction, and there is nothing else for a
  plugin to do (see README).

- **Nitro codegen + the live renderer** (plan task 3b), which is what makes the
  segmenter reachable at all:
  - `nitro.json` + three specs under `src/specs/*.nitro.ts` → 4 generated
    HybridObjects (`BackgroundRenderer`, `BackgroundRendererView`,
    `OfflineVideoProcessor`, `OfflineVideoJob`). Run with `yarn specs`; output is
    committed so consumers never need nitrogen.
  - `BackgroundRenderer.renderFrame(frame)` takes VisionCamera's `Frame` across the
    package boundary — C++ resolves `<VisionCamera/HybridFrameSpec.hpp>`, Kotlin
    `com.margelo.nitro.camera.HybridFrameSpec`.
  - **Android live renderer**: GLES2 composite (`CompositeGl`, `EglCore`) doing
    YUV→RGB plus a mask lerp in one shader pass, drawing into the view's
    `SurfaceView`. `librnskia`-free: the module's own `.so` is ~700 KB per ABI.
  - **iOS live renderer**: CoreImage `CIBlendWithMask` rendered to a `CAMetalLayer`
    through a reused `CIContext`. Deliberately CoreImage, because the offline bake
    will use the same graph — so the two agree by construction, not by testing.
  - `useBackgroundFilter()` + `<BackgroundRendererView />`. The frame worklet does
    one `renderFrame` call and always disposes the frame, even if rendering throws,
    since a leaked frame stalls the camera pipeline.
  - `BackgroundGeometry.kt` / `.swift` — the single native mirror of `geometry.ts`,
    shared by the live and offline paths on each platform (see the note in those
    files on why a native copy has to exist and what keeps it honest).

- **Three bundled default backgrounds** (`office`, `studio`, `library`) under
  `src/assets/background/`, exported as `DEFAULT_BACKGROUNDS`. `useBackgroundFilter`
  falls back to them when `backgrounds` is omitted, so the filter works with no host
  assets at all.
- **Consumer injection**: pass `backgrounds` to replace the defaults. Replacing, not
  appending — spread `DEFAULT_BACKGROUNDS` to keep both. The package still ships ids
  only, never copy; labels stay with the host.
- **Background downscaling on decode** (`MAX_BACKGROUND_EDGE_PX` = 1920) in both
  renderers. This is a correctness fix, not an optimisation: the bundled
  `bg-studio.jpg` is 8192x5464, which decodes to ~171 MB of RGBA and exceeds the
  4096px `GL_MAX_TEXTURE_SIZE` many Android GPUs report, so the texture upload would
  have failed outright on those devices. Android subsamples via `inSampleSize`; iOS
  scales the `CIImage` once at load instead of per render pass.

### Fixed

- **Live preview was rotated 90°** (found on a real iOS device). The renderers drew
  the camera buffer 1:1, ignoring `frame.orientation` — camera buffers arrive in
  sensor orientation (landscape on a portrait phone) and VisionCamera's docs are
  explicit that the consumer must counter-rotate. iOS applies `CIImage.oriented(_:)`
  via a `CameraOrientation` → `CGImagePropertyOrientation` mapping (the same one
  VisionCamera uses internally in `CG+CameraOrientation.swift`, reimplemented because
  that extension is module-internal). Android rotates the camera UV lookup in
  `CompositeGl.setRotation()` and now fits the background against the **displayed**
  dimensions, since a 90°/270° turn swaps them and a `cover` crop against the
  sensor's landscape aspect stretched the background.
  ✅ **The Android half is now verified on a Galaxy S22** — the derived sign in
  `setRotation()` was right, and the preview came out upright with no change.
- **Segmentation was fed a sideways person.** `segment(pixelBuffer:orientation:)` was
  hardcoded to `.up`, so the mask would not have matched the frame even once the
  rotation was corrected. Both now get the same orientation.
- **The background was mirrored against the camera image** on the front camera. It is
  now unmirrored in both the live and offline paths, so a background looks identical
  in the preview and in the baked file; only the person is mirrored, matching the
  shipping `expo-camera` behaviour.
- **Android: the native library was never loaded, so the entire library was inert.**
  `BackgroundFilterPackage` was "intentionally empty" on the belief that Nitro
  HybridObjects register themselves. They do — from `JNI_OnLoad`, which only runs
  once `libVisionCameraBackgroundFilter.so` is loaded, and nothing loads it
  implicitly. The generated `VisionCameraBackgroundFilterOnLoad.initializeNative()`
  had **zero callers**, so `hasHybridObject("BackgroundRenderer")` was false,
  `getSegmentationSupport()` reported every device unsupported, and consumers' own
  capability gates hid the feature with no error to go on. It now loads the library
  from a `companion object init` and **registers the generated
  `HybridBackgroundRendererViewManager`** (without which `<BackgroundRendererView />`
  has no native counterpart), mirroring VisionCamera's `VisionCameraPackage`.
- **`pixelFormat` must be `'yuv'`, not `'native'`.** `'native'` resolves to whatever
  the camera session negotiated, which on Android can be a **private** format with no
  CPU-accessible planes — and on some devices fails to configure at all (a Galaxy S22
  throws `IllegalArgumentException: PRIVATE format with resolution 1280x720 is not
supported for ImageAnalysis on the device` the moment a background is selected).
  Both renderers read planar YUV directly, so `'yuv'` is both correct and still the
  cheapest format they can consume.
- **Android: the EGL context was bound to the wrong thread.** `createWindowSurface`
  called `makeCurrent()`, but it runs on the UI thread (`SurfaceHolder` callback)
  while drawing happens on the frame-delivery thread, and an EGL context is current
  per-thread. The symptom was maximally misleading: with no context current every
  `GLES20` call is a no-op that sets no error, so `glCreateShader` returned 0 and the
  failure surfaced as `Failed to compile shader:` with an **empty** info log. Surface
  creation no longer takes the context; the drawing thread binds it per frame via a
  `makeCurrent()` that short-circuits when already current.
- **Android: the composited output was drawn correctly and then hidden.** The
  renderer's `SurfaceView` overlaps the camera preview's `SurfaceView`, and
  overlapping SurfaceViews are composited by SurfaceFlinger in surface-creation
  order — the View hierarchy has no say — so the filter appeared to do nothing while
  running at a healthy 30 fps. Now `setZOrderMediaOverlay(true)`, which raises it
  above other SurfaceViews but keeps it below the window's view content so a host's
  RN overlays still draw on top.
- **Android: the segmentation mask was rotated twice.** MLKit receives the frame's
  `rotationDegrees`, so its mask is already upright (display space), but the shader
  sampled it with `vFrameUv` — the sensor-space lookup that `uTexTransform` rotates
  for the camera texture — rotating the mask a second time and putting the silhouette
  in the wrong place entirely. The shader now carries a separate `vMaskUv` in display
  space. Same class as the iOS orientation bugs, in the opposite direction.
- **The bundled backgrounds crashed consumers that rendered them as thumbnails.** At
  their original resolutions (up to 8192x5464) a full decode is 171 MB of RGBA, over
  the ceiling `Canvas.throwIfCannotDraw` enforces — `RuntimeException: trying to draw
too large (179044352 bytes) bitmap`. `MAX_BACKGROUND_EDGE_PX` never applied, because
  that path is the consumer's image loader, not ours. All three are now **1080x1920**,
  the frame the composite targets, cutting the bundled assets from 5.8 MB to 892 KB.
- **A cancelled or failed bake leaked its partial output file**, on both platforms.
  The caller only learns the output path when the bake _succeeds_, so nothing
  downstream can clean up after an abort — the processor has to do it itself.
  - iOS did not delete anything: `cancelExport()` leaves whatever it had already
    written at `outputURL`, and an export failure did too. Both branches now remove
    the file.
  - Android deleted only when `cancelled` was set, so a genuine pipeline failure
    (a codec that refuses the format, a muxer error) still leaked a half-muxed MP4.
    The guard is now "did this run complete", which covers cancels and failures
    alike.

  Left alone, each aborted submit stranded a multi-megabyte file for the lifetime of
  the install. Now reachable from the UI, since the app grew a cancel button.

- **The capture never ran, because a `file://` URI reached `MediaMuxer`.** Found on
  the first device run. `MediaMuxer` and `MediaExtractor` take filesystem paths and
  reject URIs, but a consumer's file API hands back a URI — Expo's
  `FileSystem.cacheDirectory` is `file:///data/user/0/…`. The muxer threw during
  encoder setup, the capture disabled itself, and the app fell back to the offline
  bake, which looked exactly like a device that simply cannot capture. Both
  `CompositeVideoRecorder` and `AudioMuxer` now strip the scheme. **The silence was
  the real defect**: the package logs nothing by policy, so a caught setup failure
  left no trace anywhere — hosts should log the fallback (the app now does).
- **The encoder was asked for ~110 Mbps.** `BITS_PER_PIXEL_PER_SECOND = 4` was
  multiplied by the frame rate as well, so a 720x1280 clip requested 4 bits per pixel
  per _frame_. Now `BITS_PER_PIXEL_PER_FRAME = 0.15`, putting 720p30 near 4 Mbps — in
  line with the offline bake's 3 Mbps fallback. Same arithmetic, same fix, on iOS.
- **iOS build failure from Swift/C++ interop.** `SelfieSegmenter` was `public`, so
  Nitro's C++ interop mode emitted an extern exposing `CVPixelBuffer` into a
  generated header that never imports CoreVideo (`unknown type name 'CVBufferRef'`).
  Nothing in `ios/` is `public` now. Note single-file `swiftc -typecheck` does NOT
  catch this class of bug — it lives in generated interop glue.

### Added — offline bake, iOS (plan task 5)

- `HybridOfflineVideoProcessor` / `HybridOfflineVideoJob` implemented on iOS:
  `AVMutableVideoComposition(asset:applyingCIFiltersWithHandler:)` +
  `AVAssetExportSession`. The composition touches only the video track, so
  **AVFoundation copies the audio through and owns the muxing** — this package never
  does A/V sync.
- Runs the **same** `BackgroundCompositor`, `BackgroundGeometry` and
  `BackgroundImageLoader` as the live preview, which is what makes iOS
  preview/output parity structural. The only intended difference is quality:
  `.accurate` segmentation offline vs `.balanced` live.
- Progress reported at ~10/s (an `AVAssetExportSession` exposes progress as a
  poll-only property, hence a timer), `cancel()` maps to `cancelExport()`, and
  `1.0` is emitted exactly once on success so a consumer's progress UI lands on 100%.
- `maxOutputHeight` maps onto the nearest fixed `AVAssetExportPreset` rather than an
  invented bitrate; `0` keeps the source resolution.
- **Orientation handled explicitly.** `applyingCIFiltersWithHandler` hands over the
  RAW track pixels with `preferredTransform` _not_ applied, so a portrait clip arrives
  sideways — the same class of bug as the live preview's 90° rotation. The frame is
  rotated inside the handler and `renderSize` is set to the display size, producing an
  upright output with an identity transform; leaving the transform on the output
  instead would rotate twice on playback.
- A frame that fails to segment is written **unmodified** rather than dropped or
  composited with the previous mask, which would smear a silhouette across the clip.
- `BackgroundImageLoader` extracted so the live and offline paths decode (and
  downscale) backgrounds through one code path.

### Added — offline bake, Android (plan task 6)

- `OfflineVideoProcessor` implemented: `MediaExtractor → MediaCodec decode →
CompositeGl → MediaCodec encode → MediaMuxer`.
- **The audio track is copied sample-for-sample**, never decoded — samples move
  straight from extractor to muxer, so this code never owns A/V sync.
- **The decoder emits `YUV_420_888` images rather than feeding a SurfaceTexture**, so
  the bake reuses `CompositeGl` — the _same shader_ as the live preview — instead of a
  second OES-sampler variant. Parity is structural, matching how iOS shares one
  CoreImage graph. The cost is a per-frame CPU upload, acceptable off the realtime
  budget.
- Rotation is baked into the pixels by the GL pass, so **no orientation hint is
  written** to the output; writing one would rotate twice on playback.
- Output dimensions are rounded to even numbers (encoders reject odd ones) and capped
  by `maxOutputHeight`.
- Runs on a single daemon thread — MediaCodec's synchronous mode blocks — shut down in
  `dispose()` so a screen unmounting mid-bake doesn't leak it. `cancel()` is
  cooperative, and any run that does not complete deletes its partial output.

### Added — verification

- **`BackgroundGeometryTest.kt`** — 17 JVM unit tests asserting the Kotlin geometry
  mirror produces the _same numbers_ as the matching cases in `geometry.test.ts`. Until
  now the "keep these in step" comment was enforced by nothing. Verified to have teeth:
  inverting the cover-crop condition in the mirror fails 6 of the 17.
  Run: `./gradlew :saigontechnology_vision-camera-background-filter:testDebugUnitTest`.
- `testID`s on the record screen's background row, tiles and flip button — stable E2E
  selectors that survive i18n changes.

### Not yet implemented

- **No code.** Both offline processors exist and every path compiles. What remains is
  verification, all of which needs a device:
  - **No bake has executed on either platform.** `isOfflineBakeSupported()` is now true
    on a real build, so the bake is no longer inert — it will run.
  - ~~**The Android live renderer has never rendered a frame**~~ — ✅ **it does now.**
    Verified on a Galaxy S22 (Android 15) at **~30 fps**, upright, with the mask
    tracking the subject. Took six fixes, all listed above. The rotation sign in
    `CompositeGl.setRotation()` was **derived correctly** and needed no change.
  - **Rasteriser parity** (live pixels vs baked pixels) is not compared; only the
    geometry is. `BackgroundGeometry.swift` has no test equivalent to the Kotlin one —
    that needs a test target in the pod project.
  - **fps has never been measured**, so the ≥24fps budget is unvalidated.
- Blur effect — `BackgroundEffect` has room for `{ kind: 'blur' }`, no implementation.
