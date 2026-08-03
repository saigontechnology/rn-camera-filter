import type { BackgroundRenderer } from './BackgroundRenderer.nitro';
import type { HybridView, HybridViewMethods, HybridViewProps } from 'react-native-nitro-modules';

export interface BackgroundRendererViewProps extends HybridViewProps {
  /**
   * The {@linkcode BackgroundRenderer} whose composited output this view displays.
   *
   * The renderer can exist — and be configured — before the view mounts, which is
   * what lets the camera session start without waiting on layout.
   */
  renderer?: BackgroundRenderer;
}

// The view exposes no imperative methods, but nitrogen requires the interface to
// exist to generate the HybridView pair. VisionCamera's own view specs do the same.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface BackgroundRendererViewMethods extends HybridViewMethods {}

/**
 * The view the composited frames are drawn into.
 *
 * This is the package's replacement for VisionCamera's `FrameRendererView`,
 * which cannot be used here: its renderer accepts only a VisionCamera `Frame`,
 * never our composited pixels.
 */
export type BackgroundRendererView = HybridView<
  BackgroundRendererViewProps,
  BackgroundRendererViewMethods
>;
