// Public API. Nothing else in the package is part of the semver contract.

// ─── Types ───────────────────────────────────────────────────────────────────
export type {
  BackgroundEffect,
  BackgroundFit,
  BackgroundSource,
  Rect,
  SegmentationSupport,
  SegmentationUnsupportedReason,
  Size,
} from './types';
export type { OfflineJobResult } from './specs/OfflineVideoProcessor.nitro';

// ─── Errors ──────────────────────────────────────────────────────────────────
export {
  BackgroundFilterError,
  isBackgroundFilterError,
  type BackgroundFilterErrorCode,
} from './util/BackgroundFilterError';

// ─── Capability gate ─────────────────────────────────────────────────────────
export { useSegmentationSupport } from './hooks/useSegmentationSupport';
export { getSegmentationSupport } from './segmentation/renderer';
export type { BackgroundRenderer } from './specs/BackgroundRenderer.nitro';

// ─── Live preview ────────────────────────────────────────────────────────────
export {
  useBackgroundFilter,
  type UseBackgroundFilterOptions,
  type UseBackgroundFilterResult,
} from './hooks/useBackgroundFilter';
export { BackgroundRendererView } from './views/BackgroundRendererView';
export type {
  BackgroundRendererViewMethods,
  BackgroundRendererViewProps,
} from './specs/BackgroundRendererView.nitro';

// ─── Backgrounds ─────────────────────────────────────────────────────────────
export { resolveBackgroundUri } from './util/resolveSource';
export {
  DEFAULT_BACKGROUNDS,
  DEFAULT_BACKGROUND_IDS,
  MAX_BACKGROUND_EDGE_PX,
  type DefaultBackgroundId,
} from './assets/background';
export {
  BACKGROUND_NONE,
  findBackground,
  hasBackgrounds,
  isBackgroundSelected,
} from './backgrounds/registry';

// ─── Availability gate ───────────────────────────────────────────────────────
export {
  isBackgroundFilterAvailable,
  shouldBakeBackground,
  type ShouldBakeBackgroundOptions,
} from './gate/availability';

// ─── Host capabilities (dependency injection) ────────────────────────────────
// Ready-made adapters live behind subpaths so their dependencies stay optional:
//   `@saigontechnology/vision-camera-background-filter/adapters/expo`
export {
  configureBackgroundFilterHost,
  resetBackgroundFilterHost,
  resolveBackgroundFilterHost,
  useBackgroundFilterHost,
  NULL_FILE_SYSTEM,
} from './host/host';
export { optionalRequire } from './host/optionalRequire';
export type { BackgroundFilterFileSystem, BackgroundFilterHost } from './host/types';

// ─── Camera surfaces ─────────────────────────────────────────────────────────
// `ExpoCameraSurface` is the unfiltered fallback and lives behind a subpath, so
// `expo-camera` is only required by consumers that actually use it:
//   `@saigontechnology/vision-camera-background-filter/surfaces/expo-camera`
export { VisionCameraSurface } from './surfaces/VisionCameraSurface';
export type {
  CameraRecording,
  CameraSurfaceHandle,
  CameraSurfaceProps,
} from './surfaces/CameraSurface';

// ─── Bake failures ───────────────────────────────────────────────────────────
export {
  BakeCancelledError,
  bakeFailureReason,
  isBakeCancelled,
  isCancelledBakeError,
  type BakeFailureReason,
} from './errors/bake';

// ─── Geometry (shared by the live and offline composites) ─────────────────────
export {
  computeBackgroundLayout,
  fitScale,
  mirrorRectHorizontally,
  rotateSize,
  type BackgroundLayout,
} from './composite/geometry';

// ─── Record-time capture (records the composite the user is watching) ────────
export {
  isCompositeCaptureSupported,
  startCompositeCapture,
  type CompositeCapture,
  type CompositeCaptureResult,
  type FinishCompositeCaptureOptions,
  type StartCompositeCaptureOptions,
} from './capture/compositeCapture';

// ─── Offline bake (the fallback: bake into an already-recorded file) ─────────
export {
  isOfflineBakeSupported,
  processVideoBackground,
  type ProcessVideoBackgroundOptions,
} from './offline/processVideoBackground';
