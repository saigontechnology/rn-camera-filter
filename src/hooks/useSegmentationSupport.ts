import { useMemo } from 'react';

import { getSegmentationSupport } from '../segmentation/renderer';

import type { SegmentationSupport } from '../types';

/**
 * Whether this device can replace the camera background.
 *
 * Support is a static property of the build + device (OS version, model
 * availability), so it is resolved once and memoized. Consumers use it to hide
 * the background picker entirely rather than showing a control that cannot work.
 */
export function useSegmentationSupport(): SegmentationSupport {
  return useMemo(() => getSegmentationSupport(), []);
}
