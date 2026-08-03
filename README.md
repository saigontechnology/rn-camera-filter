# @saigontechnology/vision-camera-background-filter

> Real-time selfie background replacement for **react-native-vision-camera 5** — and,
> unlike a preview-only filter, the background ends up **in the delivered file**.

Segmentation and compositing are entirely native (Vision on iOS, MLKit on Android), so
there is no per-frame JavaScript work and no mask crossing the bridge. Measured ~30 fps
on a Galaxy S22.

```tsx
const Surface = isBackgroundFilterAvailable() ? VisionCameraSurface : ExpoCameraSurface;

<Surface ref={ref} facing="front" onReady={onReady} backgroundId={selectedId} />;

const { uri, hasBackground } = (await ref.current.record(30))!;
```

---

## Demo

Recorded on device — live preview, background switching, and the record-time capture
producing a clip that already contains the background.

Watch for three things in both clips: the background picker is only on screen because
`isBackgroundFilterAvailable()` returned true; the subject stays un-mirrored against a
never-mirrored background; and the clip handed to the preview screen needs no bake at
all, because `hasBackground` came back `true`.

### iOS — Vision segmentation, CoreImage → Metal

https://github.com/user-attachments/assets/e0bc8109-3302-48a9-9e11-e3942eaced84

### Android — MLKit selfie segmentation, GLES2 shader

https://github.com/user-attachments/assets/bf7169e1-2d29-4b14-80e5-e432f10058c7

<!--
  Both URLs are GitHub attachment-CDN links, and they are the ONLY way to embed a
  playing video in a README. Do not "tidy" them into a table, a markdown link, or a
  <video> tag:

    - A bare attachment URL on its own line is what GitHub converts into a player.
      The same URL inside a table cell or as [text](url) stays an inert link.
    - <video> is removed outright by GitHub's Markdown sanitiser, whatever its src.
      Verified against POST https://api.github.com/markdown: <video src="…"> renders
      as an empty <p></p>, and a nested <source> keeps the tag but loses its src.
    - ![](…mp4) renders as a broken image.

  Source files also live in assets/demo/ for anyone reading this outside GitHub.
  To replace a clip: drag the new file into a new issue on this repo (do NOT submit
  it), copy the user-attachments URL it produces, and swap it in above. Videos are
  capped at 10 MB on Free plans, 100 MB on paid.
-->

The source files are committed at [`assets/demo/`](./assets/demo/) for anyone reading
this outside GitHub, where the embeds above will not render.

---

## Contents

- [Demo](#demo)
- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Installation — Expo](#installation--expo)
- [Installation — React Native (bare)](#installation--react-native-bare)
- [Verify the install](#verify-the-install)
- [Quick start (new project)](#quick-start-new-project)
- [Backgrounds](#backgrounds)
- [Getting the background into the file](#getting-the-background-into-the-file)
- [Host capabilities (dependency injection)](#host-capabilities-dependency-injection)
- [API reference](#api-reference)
- [Behaviour you must know](#behaviour-you-must-know)
- [Troubleshooting](#troubleshooting)
- [AI assistants](#ai-assistants)
- [Architecture](#architecture)
- [Working on the package](#working-on-the-package)

---

## What you get

|                               |                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| **Live preview**              | A background composited into the camera preview in realtime, natively.                    |
| **Record-time capture**       | The clip you record already contains the background — no post-processing wait.            |
| **Offline bake**              | A fallback that composites into an existing file (a failed capture, or a gallery import). |
| **Capability gate**           | One call that tells you whether this device can do any of it, so you can hide the UI.     |
| **Drop-in camera surfaces**   | Both halves of that branch behind one ref contract, so a record screen is one ternary.    |
| **Three bundled backgrounds** | `office`, `studio`, `library` — replaceable with your own.                                |

The package ships **ids, never copy**. It has no i18n, no theme, no navigation, no
logging, and no Redux. Everything user-visible crosses the API boundary as an argument.

---

## Requirements

|              | Minimum                         | Note                                                                   |
| ------------ | ------------------------------- | ---------------------------------------------------------------------- |
| React Native | 0.78                            | New Architecture required (Nitro modules)                              |
| React        | 19                              |                                                                        |
| iOS          | 13 to build, **15+ to segment** | Gated at runtime — older devices report unsupported, they do not crash |
| Android      | **minSdk 24**, compileSdk 36    |                                                                        |
| Expo         | SDK 53+                         | **Dev build required** — does not run in Expo Go                       |

**Expo Go will never work.** This package contains custom native code, so it needs a
development build (`npx expo prebuild` + `run:ios`/`run:android`) or EAS Build.

### Peer dependencies

```
react-native-vision-camera           >=5.1    the camera
react-native-vision-camera-worklets  >=5.1    frame processors
react-native-nitro-modules           >=0.36   the native bridge
react-native-nitro-image             >=0.15   VisionCamera peer
react-native-worklets                >=0.10   Software Mansion — NOT worklets-core

expo-file-system                     >=19     OPTIONAL — only for /adapters/expo
expo-camera                          >=17     OPTIONAL — only for /surfaces/expo-camera
```

No `@shopify/react-native-skia` — see [Architecture](#architecture). That is 25 MB/ABI
of `librnskia.so` this package deliberately does not cost you.

#### How the optional ones stay optional

Each lives behind its own **subpath export**. Importing the subpath is the only thing
that pulls the dependency into your bundle:

| Subpath                 | Needs              | Skip it if…                                         |
| ----------------------- | ------------------ | --------------------------------------------------- |
| `/adapters/expo`        | `expo-file-system` | you implement `BackgroundFilterFileSystem` yourself |
| `/surfaces/expo-camera` | `expo-camera`      | you already have an unfiltered camera               |

This is the only mechanism that works. **A `try { require(…) }` does not make a
dependency optional in React Native** — Metro resolves `require` statically while
building the module graph, so an uninstalled package is a _bundling_ error and the catch
never runs. Nothing in the core entry point imports either optional dependency.

---

## Installation — Expo

### 1. Install the package and its peers

```bash
npx expo install @saigontechnology/vision-camera-background-filter \
  react-native-vision-camera \
  react-native-vision-camera-worklets \
  react-native-nitro-modules \
  react-native-nitro-image \
  react-native-worklets

# Optional, but recommended — enables the record-time capture and the unfiltered fallback
npx expo install expo-file-system expo-camera
```

### 2. Enable worklets in `babel.config.js`

Reanimated 4 already brings `react-native-worklets`; the Babel plugin must be **last**.

```js
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'], // must be the LAST plugin
  };
};
```

### 3. Declare camera + microphone permissions

**This package ships no Expo config plugin, deliberately** — see
[why](#why-no-config-plugin). Permissions come from `expo-camera`'s plugin, which is the
single source of all three strings:

```ts
// app.config.ts
plugins: [
  [
    'expo-camera',
    {
      cameraPermission: 'Allow $(PRODUCT_NAME) to use your camera to record your video.',
      microphonePermission: 'Allow $(PRODUCT_NAME) to use your microphone to record audio.',
      recordAudioAndroid: true,
    },
  ],
];
```

Not using `expo-camera`? Write them yourself instead — do **not** do both, or you get
conflicting Info.plist keys:

```ts
ios: {
  infoPlist: {
    NSCameraUsageDescription: '…',
    NSMicrophoneUsageDescription: '…',
  },
},
android: {
  permissions: ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'],
},
```

### 4. Raise the Android SDK levels

VisionCamera 5 needs `compileSdk 36`; this package needs `minSdk 24`.

```ts
// app.config.ts
plugins: [
  [
    'expo-build-properties',
    {
      android: { compileSdkVersion: 36, targetSdkVersion: 36, minSdkVersion: 24 },
      ios: { deploymentTarget: '15.1' },
    },
  ],
];
```

### 5. Build

```bash
npx expo prebuild --clean
npx expo run:ios       # or: npx expo run:android
```

> `--clean` matters on the first install. Autolinking discovers the module from its
> podspec and `android/build.gradle`; a stale `ios/`/`android/` folder will not pick it up.

### 6. Wire the host, once, at startup

```tsx
// app/_layout.tsx (or App.tsx)
import { configureBackgroundFilterHost } from '@saigontechnology/vision-camera-background-filter';
import { createExpoBackgroundFilterHost } from '@saigontechnology/vision-camera-background-filter/adapters/expo';

configureBackgroundFilterHost(createExpoBackgroundFilterHost());
```

Do this before any camera screen mounts. See
[Host capabilities](#host-capabilities-dependency-injection) for what it supplies and
what happens if you skip it (spoiler: it still works, just slower).

---

## Installation — React Native (bare)

### 1. Install

```bash
yarn add @saigontechnology/vision-camera-background-filter \
  react-native-vision-camera react-native-vision-camera-worklets \
  react-native-nitro-modules react-native-nitro-image react-native-worklets

cd ios && pod install && cd ..
```

Autolinking finds the module from its root `*.podspec` and `android/build.gradle`. There
is nothing to register by hand.

### 2. `babel.config.js`

```js
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['react-native-worklets/plugin'], // must be the LAST plugin
};
```

### 3. `android/build.gradle`

```gradle
buildscript {
  ext {
    minSdkVersion = 24        // this package's floor
    compileSdkVersion = 36    // VisionCamera 5 requires it
    targetSdkVersion = 36
  }
}
```

New Architecture must be on (`newArchEnabled=true` in `android/gradle.properties`) — Nitro
modules require it.

### 4. Permissions

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

```xml
<!-- ios/<App>/Info.plist -->
<key>NSCameraUsageDescription</key>
<string>Allow $(PRODUCT_NAME) to use your camera to record your video.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Allow $(PRODUCT_NAME) to use your microphone to record audio.</string>
```

### 5. Supply the host

Bare projects have no `expo-file-system`, so implement the two members against whatever
filesystem you do have:

```ts
import RNFS from 'react-native-fs';
import { configureBackgroundFilterHost } from '@saigontechnology/vision-camera-background-filter';

configureBackgroundFilterHost({
  fileSystem: {
    cacheDirectory: `${RNFS.CachesDirectoryPath}/`, // plain path, trailing slash, NO file://
    deleteFile: (path) => void RNFS.unlink(path).catch(() => {}),
  },
  onWarn: (message, error) => console.warn(message, error),
});
```

### Monorepo / Yarn workspaces

Consuming the package from a workspace rather than npm? Metro needs to watch it:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config'); // or @react-native/metro-config
const path = require('path');

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, 'packages')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
config.resolver.extraNodeModules = {
  react: path.resolve(__dirname, 'node_modules/react'),
  'react-native': path.resolve(__dirname, 'node_modules/react-native'),
};
module.exports = config;
```

---

## Verify the install

Before writing any UI, confirm the native side actually linked:

```ts
import {
  getSegmentationSupport,
  isOfflineBakeSupported,
} from '@saigontechnology/vision-camera-background-filter';

console.log(getSegmentationSupport()); // { supported: true }  ← native is linked
console.log(isOfflineBakeSupported()); // true
```

`{ supported: false, reason: 'no-model' }` on a device that should work almost always
means the native module did not link — rebuild, do not debug your JS. See
[Troubleshooting](#troubleshooting).

---

## Quick start (new project)

A complete record screen. This is the path to copy; everything else in this README is
detail underneath it.

```tsx
import { useRef, useState } from 'react';
import { StyleSheet, View, Button } from 'react-native';
import {
  DEFAULT_BACKGROUNDS,
  BACKGROUND_NONE,
  isBackgroundFilterAvailable,
  VisionCameraSurface,
  type CameraSurfaceHandle,
} from '@saigontechnology/vision-camera-background-filter';
import { ExpoCameraSurface } from '@saigontechnology/vision-camera-background-filter/surfaces/expo-camera';

export function RecordScreen() {
  const ref = useRef<CameraSurfaceHandle>(null);
  const [ready, setReady] = useState(false);
  const [backgroundId, setBackgroundId] = useState<string>(BACKGROUND_NONE);

  // Resolve ONCE per mount. Swapping surfaces mid-session tears down a live
  // capture session, and device capability cannot change while the app runs.
  const [available] = useState(() => isBackgroundFilterAvailable());
  const Surface = available ? VisionCameraSurface : ExpoCameraSurface;

  const start = async () => {
    // Resolves when recording stops — by your stop() or by hitting 30s.
    const result = await ref.current?.record(30);
    if (result == null) return; // session torn down; nothing usable

    if (result.hasBackground) {
      upload(result.uri); // the background is already in the pixels
    } else {
      upload(await bakeIfNeeded(result.uri, backgroundId)); // see below
    }
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      <Surface
        ref={ref}
        style={StyleSheet.absoluteFill}
        facing="front"
        onReady={() => setReady(true)}
        backgroundId={backgroundId}
      />

      {/* Only offer the picker when the filter can actually composite. */}
      {available && (
        <View style={styles.row}>
          <Button title="None" onPress={() => setBackgroundId(BACKGROUND_NONE)} />
          {DEFAULT_BACKGROUNDS.map((bg) => (
            <Button key={bg.id} title={bg.id} onPress={() => setBackgroundId(bg.id)} />
          ))}
        </View>
      )}

      <Button title="Record" disabled={!ready} onPress={start} />
      <Button title="Stop" onPress={() => ref.current?.stop()} />
    </View>
  );
}
```

And the fallback for a clip that came back without its background:

```tsx
import {
  findBackground,
  processVideoBackground,
  shouldBakeBackground,
  DEFAULT_BACKGROUNDS,
} from '@saigontechnology/vision-camera-background-filter';

async function bakeIfNeeded(uri: string, backgroundId: string) {
  if (!shouldBakeBackground({ background: backgroundId })) return uri;

  const background = findBackground(DEFAULT_BACKGROUNDS, backgroundId);
  if (background == null) return uri;

  const { outputPath } = await processVideoBackground({
    inputPath: uri,
    background,
    fit: 'cover',
    mirror: false, // recorded files are never mirrored
    onProgress: (p) => setPct(Math.round(p * 100)),
  });
  return outputPath;
}
```

### The five rules

1. **Resolve the surface once per mount**, not on every render.
2. **Hide the picker when `isBackgroundFilterAvailable()` is false.** A control that
   cannot do anything is worse than no control.
3. **Branch on `result.hasBackground`, never on the user's selection.** A capture that
   failed reports `false` even though a background was picked — that is what makes the
   fallback safe.
4. **`record()` resolving `undefined` is not an error.** It means the session was torn
   down (the user navigated away). Only a rejection is a failure — and on iOS a teardown
   _rejects_, so check an unmounted flag before surfacing it.
5. **Trim before you bake**, so you only process the seconds you keep.

---

## Backgrounds

Three are bundled, so the feature works out of the box:

```ts
useBackgroundFilter({ effect: { kind: 'image', id: 'office' } }); // office | studio | library
```

Passing `backgrounds` **replaces** the defaults rather than appending — a consumer with a
curated set almost never wants three stock images added to it. Spread them for both:

```ts
const MY_BACKGROUNDS = [
  ...DEFAULT_BACKGROUNDS,
  { id: 'home', source: require('./assets/home.jpg') },
  { id: 'remote', source: { uri: 'https://cdn.example.com/bg.jpg' } },
];
```

`source` is a `require()`d asset or a `{ uri }`; both resolve to a URI that native
decodes. Labels are yours — the package has no i18n.

> ⚠️ **Size your images near 1080×1920.** Both renderers downscale to
> `MAX_BACKGROUND_EDGE_PX` (1920) at decode, but **that does not protect your thumbnails**
> — those go through your own image loader. An 8192×5464 source decodes to ~171 MB of
> RGBA and throws `RuntimeException: trying to draw too large bitmap` on Android.

---

## Getting the background into the file

VisionCamera 5 splits the session into independent parallel outputs. Compositing inside a
`CameraFrameOutput` does **not** affect what `CameraVideoOutput` records, and there is no
supported route from a composited frame into the `Recorder`. This package closes that gap
twice over — and `VisionCameraSurface` already does all of it for you.

### 1. Record-time capture — the fast path

```
CameraFrameOutput ──► renderFrame() ─┬─► preview  (mirrored, cropped to the view)
                                     └─► encoder  (unmirrored, whole frame) ──► composite.mp4
CameraVideoOutput ──► Recorder ──────────────────────────────────────────────► raw.mp4
                                                                                  │
composite.mp4 (video) + raw.mp4 (audio) ──► remux, neither track re-encoded ──────┘
```

The delivered pixels **are** the previewed pixels, so there is nothing to keep in sync and
nothing to wait for. Audio never passes through this package's hands: the remux is a
container operation (`AVMutableComposition` passthrough / `MediaExtractor` → `MediaMuxer`)
that takes about a second on a 30 s clip.

Doing it manually:

```tsx
const capture = isCompositeCaptureSupported(renderer)
  ? startCompositeCapture({
      renderer,
      outputPath: `${cacheDir}composite-${Date.now()}.mp4`,
      maxOutputHeight: 1920,
      aspectRatio: 9 / 16, // match what your recorder writes, or shapes diverge
    })
  : null;

const rawPath = await startTheCamerasOwnRecorder(); // has the audio, not the background

if (capture != null) {
  const { outputPath, capturePath } = await capture.finish({ audioSourcePath: rawPath });
  deleteFile(capturePath); // both inputs are consumed by the mux
  deleteFile(rawPath);
  return { uri: outputPath, hasBackground: true };
}
return { uri: rawPath, hasBackground: false }; // fall through to the bake
```

**Stop the capture at the same instant you stop the recorder** — not when the recorder's
file arrives, hundreds of milliseconds later. The remux infers the head offset from the
difference between the two durations, and a loose tail corrupts that inference.

### 2. Offline bake — the fallback

For devices that cannot capture, encoders that fail mid-take, and clips that never came
from this camera (a gallery import):

```tsx
const { outputPath, durationMs } = await processVideoBackground({
  inputPath: trimmedPath,
  background,
  fit: 'cover',
  onProgress: setPct, // 0..1, throttled natively to ~10/s
  signal: abortController.signal,
});
```

The offline pass copies the **audio track through untouched**, so this package never owns
A/V muxing or sync — where the hard, device-specific bugs live.

Budget **0.3–1× realtime** (10–60 s for a 30 s clip). It needs a progress UI and a cancel
path. A cancelled or failed bake deletes its own partial output; the caller never learns
that path, so nothing else could clean it up.

```tsx
try {
  await processVideoBackground({ …, signal });
} catch (e) {
  if (isCancelledBakeError(e)) return; // the user's decision, not a failure
  toast.error(t(KEYS[bakeFailureReason(e)]));
}
```

**A failed bake should abort your submit**, unlike a best-effort compress step. Silently
uploading a clip without the background the user recorded with reads as data loss.

---

## Host capabilities (dependency injection)

The record-time capture needs a scratch directory and a way to delete temp files. This
package refuses to pick a filesystem library for you, so they cross the boundary as two
functions:

```ts
// Expo — one line.
configureBackgroundFilterHost(createExpoBackgroundFilterHost());

// Anyone else — it is two members.
configureBackgroundFilterHost({
  fileSystem: {
    cacheDirectory: '/data/user/0/app/cache/', // plain path, NO file:// scheme
    deleteFile: (path) => void RNFS.unlink(path).catch(() => {}),
  },
  onWarn: (message, error) => log.warn(message, error),
});
```

Both fields are independently optional and calls **merge**, so `onWarn` and `fileSystem`
can be wired from different places without one clobbering the other. Per-mount overrides
go through the `host` prop on a camera surface (pass a stable reference — it is a memo
dependency).

**Leaving it unconfigured is safe.** With no cache directory the record-time capture is
skipped, the raw recording is handed on with `hasBackground: false`, and your offline bake
puts the background in as it would on a device that could not capture — slower, same clip.

**Wire `onWarn` anyway.** Without it, a capture that failed and fell back is
indistinguishable from a device that never supported one, and that is the first thing you
will want to know when a filtered recording comes back unfiltered.

`cacheDirectory` is a **plain path, not a `file://` URI** — Android's `MediaMuxer` rejects
a URI outright. The Expo adapter strips the scheme for you.

---

## API reference

### Capability

| Export                        | Signature                                  | Notes                                                                                      |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `isBackgroundFilterAvailable` | `({ backgrounds? }?) => boolean`           | Assets ⋀ device support. **No feature flag** — `&&` your own if you want a staged rollout. |
| `getSegmentationSupport`      | `() => SegmentationSupport`                | `{ supported, reason?: 'os-version' \| 'no-model' \| 'unsupported-device' }`               |
| `useSegmentationSupport`      | `() => SegmentationSupport`                | Hook form.                                                                                 |
| `isCompositeCaptureSupported` | `(renderer) => boolean`                    | Record-time capture.                                                                       |
| `isOfflineBakeSupported`      | `() => boolean`                            | The bake. Probed **separately** — a device can have one and not the other.                 |
| `shouldBakeBackground`        | `(ShouldBakeBackgroundOptions) => boolean` | Pure; every capability injectable for tests.                                               |

### Camera surfaces

| Export                | From                    | Notes                                                                                 |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `VisionCameraSurface` | root                    | Filtered. Props: `facing`, `onReady`, `style`, `backgroundId`, `backgrounds`, `host`. |
| `ExpoCameraSurface`   | `/surfaces/expo-camera` | Unfiltered fallback. Same props; ignores the background ones.                         |
| `CameraSurfaceHandle` | root (type)             | `record(maxDurationSec) => Promise<CameraRecording \| undefined>`, `stop()`           |
| `CameraRecording`     | root (type)             | `{ uri, hasBackground }` — `hasBackground` describes the **file**.                    |

### Live preview (compose it yourself)

| Export                      | Notes                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useBackgroundFilter(opts)` | `→ { frameOutput, renderer, support }`. Opts: `effect`, `backgrounds`, `fit`, `mirror`, `mirrorCamera`, `targetResolution`, `previewSizedFrames`. |
| `BackgroundRendererView`    | `<BackgroundRendererView renderer={renderer} style={…} />`. Mount **only** while filtering.                                                       |

### Recording & baking

| Export                         | Notes                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `startCompositeCapture(opts)`  | `→ CompositeCapture` with `stop()`, `finish({ audioSourcePath })`, `cancel()`.                         |
| `processVideoBackground(opts)` | `→ Promise<{ outputPath, durationMs }>`. Supports `onProgress`, `signal`, `mirror`, `maxOutputHeight`. |

### Backgrounds & errors

| Export                                                                         | Notes                                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `DEFAULT_BACKGROUNDS`, `DEFAULT_BACKGROUND_IDS`                                | The bundled three.                                                                                         |
| `BACKGROUND_NONE`                                                              | `'none'` sentinel.                                                                                         |
| `findBackground(list, id)`, `hasBackgrounds(list)`, `isBackgroundSelected(id)` | Generic in the element type.                                                                               |
| `resolveBackgroundUri(bg)`                                                     | Asset id / `{ uri }` → URI.                                                                                |
| `BackgroundFilterError`                                                        | `code`: `unsupported \| decode-failed \| encode-failed \| cancelled \| io`. The only type it rejects with. |
| `bakeFailureReason(e)`                                                         | → `'unsupported' \| 'cancelled' \| 'failed'`. Map to your own copy.                                        |
| `BakeCancelledError`, `isBakeCancelled`, `isCancelledBakeError`                | Cancel vs failure. Do not confuse the last two — see their docs.                                           |

### Host

`configureBackgroundFilterHost`, `resolveBackgroundFilterHost`, `useBackgroundFilterHost`,
`resetBackgroundFilterHost`, `NULL_FILE_SYSTEM`, `optionalRequire`.

### Geometry

`computeBackgroundLayout`, `fitScale`, `mirrorRectHorizontally`, `rotateSize` — the same
math both native renderers mirror. Exported so you can assert against it.

---

## Behaviour you must know

**Mirroring.** The front preview is mirrored; recorded files are not. The **background is
never mirrored on either path** — mirroring it would flip it against the person and make
the preview disagree with the file. `mirrorCamera` flips the camera and its mask together;
`mirror` flips the background. Set `mirrorCamera: facing === 'front'`, leave `mirror`
false, and prefer backgrounds without text.

**Rear camera.** Both segmentation models are tuned for front-facing selfies. Reset the
background to `none` when the user flips to the rear camera.

**Overlays are not composited.** A teleprompter, countdown or watermark drawn as a React
Native view sits outside both composites and will not appear in the file. That is correct
— state it in your code so nobody "fixes" it.

**Resolution vs frame rate.** `useBackgroundFilter`'s `targetResolution` defaults to 4:3
`960×1280` to match the preview stream's field of view, not VisionCamera's 16:9 default —
a 16:9 analysis stream is a _crop_, so the subject looks closer the moment a background is
selected. Measured on a Galaxy S22: 960×1280 → 28.7 fps, 1440×1920 → 22.2 fps (under
budget on a flagship). Raise it only if a sharper file matters more than smoothness.

**`previewSizedFrames` caps your recording.** It makes frames cheaper, but the capture
encodes those same frames — `true` yielded a 540×960 recording on an S22. Leave it `false`
when you record.

**Orientation.** The bake re-encodes, so it can change orientation metadata. Round-trip
whatever consumes the file (trim, thumbnails, playback) after enabling it.

---

## Troubleshooting

| Symptom                                                              | Cause                                                             | Fix                                                                                                                                         |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `getSegmentationSupport()` → `supported: false` on a capable device  | Native module not linked                                          | `npx expo prebuild --clean` + rebuild. Do not debug JS.                                                                                     |
| Module missing from Android autolinking, iOS fine                    | A non-empty `sourceDir`/`podspecPath` in `react-native.config.js` | Keep both platform entries **empty**. Paths there resolve relative to the package root and silently point nowhere.                          |
| `PRIVATE format … not supported for ImageAnalysis` (S22)             | `pixelFormat: 'native'`                                           | Use `'yuv'`. The renderers consume planar YUV directly.                                                                                     |
| Filtered clip has **no audio** on iOS                                | Recorded as `.mp4`                                                | Use `fileType: 'mov'` on iOS. `AVCaptureMovieFileOutput` always writes QuickTime; the `.mp4` parser then silently discards the audio track. |
| Audio runs ~370 ms ahead of video                                    | Composite encoder started **before** the recorder                 | Start the recorder first and `await` its promise, then start the capture.                                                                   |
| Filtered clip is a different shape than an unfiltered one            | `aspectRatio` left at 0                                           | Pass what your recorder writes (e.g. `9/16`).                                                                                               |
| Android crash: `trying to draw too large bitmap`                     | Oversized background rendered as a thumbnail                      | Re-export near 1080×1920.                                                                                                                   |
| Capture never runs; always bakes                                     | No `cacheDirectory`                                               | Call `configureBackgroundFilterHost`. Wire `onWarn` to see why.                                                                             |
| Preview shows a blank rectangle                                      | `BackgroundRendererView` mounted with no frames arriving          | Mount it only when `renderer != null`.                                                                                                      |
| Android: clip plays but `expo-video` thumbnails are empty (iOS fine) | `CameraRecording.uri` is a **schemeless** path                    | Prefix `file://` for the player only — see below.                                                                                           |
| Cannot find module / no type declarations                            | Editor TS server cached a stale `package.json`                    | Restart the TS server.                                                                                                                      |

### The schemeless-path trap on Android

`CameraRecording.uri` is a **plain absolute path on Android**, not a `file://` URI —
VisionCamera's recorder returns `file.absolutePath`, and this package's composite/mux
output is a plain path deliberately, because `MediaMuxer` rejects a URI.

Most consumers cope. media3/ExoPlayer routes a `Uri` with a `null` scheme to
`FileDataSource` exactly as it does `file://`, so the clip **plays** fine. But
`expo-video`'s `generateThumbnailsAsync` builds its `MediaMetadataRetriever` behind
`URLUtil.isFileUrl(uri)` — a literal `startsWith("file:")`. A bare path fails that check,
falls through to the final `else`, and is handed to the **network** overload of
`setDataSource`, which throws. You get a playing video and an empty thumbnail strip, on
Android only.

Normalise at the point of use, for the player alone:

```ts
const toPlayerSource = (v: string) => (v.startsWith('/') ? `file://${v}` : v);

const player = useVideoPlayer(toPlayerSource(uri)); // thumbnails work
await processVideoBackground({ inputPath: uri }); // plain path — do NOT prefix
```

Keep the plain path for everything native (`processVideoBackground`, video trimmers,
muxers, upload). Prefixing globally trades one bug for another.

---

## AI assistants

This package ships machine-readable docs so a coding agent can integrate it without you
explaining any of the above.

| File                               | Contents                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| [`llms.txt`](./llms.txt)           | Concise index: what it is, install, the canonical usage, the rules that are easy to get wrong.    |
| [`llms-full.txt`](./llms-full.txt) | Full reference: every export, complete working integration, all known pitfalls with their causes. |

Both ship inside the published package, so they are on disk at
`node_modules/@saigontechnology/vision-camera-background-filter/`.

### Give this to your agent

**Claude Code, Cursor, Codex, Copilot** — paste this:

```
Read node_modules/@saigontechnology/vision-camera-background-filter/llms.txt and
follow it to add a camera screen with real-time background replacement to this app.
Use llms-full.txt in the same folder for the complete API and the pitfall list.
```

Working from a checkout rather than node_modules? Point at
`packages/vision-camera-background-filter/llms.txt` instead.

### Make it permanent

Add a pointer to your repo's agent instructions so you never have to say it again:

```md
<!-- CLAUDE.md / .cursorrules / AGENTS.md -->

## Camera background filter

Before touching camera or background-filter code, read
`node_modules/@saigontechnology/vision-camera-background-filter/llms.txt`.
It is the source of truth for this package — do not infer its API from usage.
```

### Why bother

The four mistakes an agent makes without it, every time: branching on the user's selected
background instead of `result.hasBackground`; treating a `record()` that resolves
`undefined` as an error; resolving the camera surface on every render instead of once per
mount; and adding a `try { require() }` for the optional deps, which breaks the Metro
build rather than degrading. All four are called out explicitly in `llms.txt`.

---

## Architecture

### Why the live path is native, not Skia

The obvious route — VisionCamera's `FrameRenderer` → `NativeFrameRendererView` — does not
work: `FrameRenderer.renderFrame(frame: Frame)` accepts only a VisionCamera `Frame`, so a
composited image cannot be handed to it. Recording an `SkPicture` in the frame worklet and
pushing it through the `SkiaViewApi` JSI global would keep two rasterizers and the Skia
binary, and rests on `SkiaViewApi` being reachable from the camera thread's worklet
runtime.

Instead the package ships its own renderer, which VisionCamera's own docstring points at
("You could also build a custom video recorder that accepts `Frame`s via a
`FrameRenderer`"). Both platforms expose the needed extension point publicly:

| Platform | Hook                           | Gives us                        |
| -------- | ------------------------------ | ------------------------------- |
| iOS      | `public protocol NativeFrame`  | `sampleBuffer: CMSampleBuffer?` |
| Android  | `public interface NativeFrame` | `image: ImageProxy`             |

### Preview/output parity

Two composite implementations that must agree visually is the main risk of the fallback
model. Two things contain it:

- **One geometry specification.** `src/composite/geometry.ts` owns all
  fit/crop/mirror/rotation math, pure and unit-tested (36 tests). A GPU pipeline cannot
  call TypeScript, so each platform has exactly **one** mirror of it —
  `BackgroundGeometry.kt` / `.swift` — shared by that platform's live _and_ offline path.
  `BackgroundGeometryTest.kt` asserts the Kotlin mirror produces the same numbers.
  Do not add a third.
- **One rasterizer per platform.** The live composite is native (CoreImage/Metal on iOS,
  GLES2 on Android), so it shares its blend path with the offline bake instead of racing a
  second rasterizer.

### Why no config plugin

VisionCamera 5 ships none either, and `expo-camera`'s plugin is already the single source
of `NSCameraUsageDescription`, `NSMicrophoneUsageDescription` and `recordAudioAndroid` —
duplicating them produces conflicting keys. `Vision.framework` is part of iOS, and MLKit's
`segmentation-selfie` artifact is **bundled-only** (the model ships inside the APK), so
there is no download toggle to expose and nothing left for a plugin to do.

### Size

`libVisionCameraBackgroundFilter.so` is **~700 KB per ABI**, plus MLKit's bundled model
(~5 MB, ABI-independent). Compare Skia's `librnskia.so` at 25 MB/ABI, which route 2 avoids
entirely. Measure against a release build before shipping.

---

## Working on the package

```bash
yarn specs      # regenerate the Nitro bindings (output is committed)
yarn typecheck
yarn test       # from the repo root — geometry, gate, host, registry, errors
```

```sh
# Geometry parity — asserts the Kotlin mirror matches geometry.ts's numbers
./gradlew :saigontechnology_vision-camera-background-filter:testDebugUnitTest

# Android — compiles the module on its own
./gradlew :saigontechnology_vision-camera-background-filter:assembleDebug

# Autolinking discovery, per platform
npx expo-modules-autolinking react-native-config --platform ios
npx expo-modules-autolinking react-native-config --platform android
```

The package must stay extractable: **no imports from the host app** (`@/…`, Redux, i18n,
theme) — ESLint enforces it. Strings, colours and dimensions cross the API boundary as
arguments.

## License

MIT
