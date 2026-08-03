import { getHostComponent } from 'react-native-nitro-modules';

import type {
  BackgroundRendererViewMethods,
  BackgroundRendererViewProps,
} from '../specs/BackgroundRendererView.nitro';

/**
 * The view that displays the composited camera output.
 *
 * Render it in place of (or over) VisionCamera's preview while a background is
 * active. It draws nothing until a `renderer` is attached and frames start
 * arriving, so mount it only when the filter is on — otherwise the user sees a
 * blank rectangle instead of the camera.
 */
export const BackgroundRendererView = getHostComponent<
  BackgroundRendererViewProps,
  BackgroundRendererViewMethods
>('BackgroundRendererView', () =>
  require('../../nitrogen/generated/shared/json/BackgroundRendererViewConfig.json'),
);
