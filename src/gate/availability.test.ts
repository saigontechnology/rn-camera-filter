import { isBackgroundFilterAvailable, shouldBakeBackground } from './availability';
import { BACKGROUND_NONE } from '../backgrounds/registry';

import type { BackgroundSource } from '../types';

const BACKGROUNDS: BackgroundSource[] = [{ id: 'office', source: 1 }];

// Under Jest the Nitro mock reports no HybridObjects, so both native probes are
// false. That makes the unsupported-device branch the default and lets the
// supported cases be expressed by injection, with no native stubbing.
describe('isBackgroundFilterAvailable', () => {
  it('is false when the device cannot segment', () => {
    expect(isBackgroundFilterAvailable({ backgrounds: BACKGROUNDS })).toBe(false);
  });

  it('is false when there are no backgrounds, whatever the device can do', () => {
    expect(isBackgroundFilterAvailable({ backgrounds: [] })).toBe(false);
  });
});

describe('shouldBakeBackground', () => {
  const ON = { filterAvailable: true, bakeSupported: true };

  it('bakes when the filter is available, the bake is supported, and a background is set', () => {
    expect(shouldBakeBackground({ background: 'office', ...ON })).toBe(true);
  });

  it.each([BACKGROUND_NONE, undefined, null])('skips when the background is %s', (background) => {
    expect(shouldBakeBackground({ background, ...ON })).toBe(false);
  });

  it('skips when the device gate is closed', () => {
    expect(shouldBakeBackground({ background: 'office', ...ON, filterAvailable: false })).toBe(
      false,
    );
  });

  // The live renderer and the offline processor are different native components,
  // and a device can have one without the other.
  it('skips when the native offline processor is unavailable', () => {
    expect(shouldBakeBackground({ background: 'office', ...ON, bakeSupported: false })).toBe(false);
  });

  it('requires BOTH capabilities, not either', () => {
    expect(
      shouldBakeBackground({ background: 'office', filterAvailable: false, bakeSupported: false }),
    ).toBe(false);
  });

  // The record-time capture already put the background in the pixels. Baking
  // again would re-encode for nothing and — worse — segment a frame that already
  // contains a background, compositing over the wrong subject.
  it('skips when the clip was composited while recording', () => {
    expect(shouldBakeBackground({ background: 'office', ...ON, alreadyComposited: true })).toBe(
      false,
    );
  });

  // A capture that failed falls back to the raw recording and reports
  // `hasBackground: false`; the bake must then run exactly as before.
  it('still bakes when the capture did not composite the clip', () => {
    expect(shouldBakeBackground({ background: 'office', ...ON, alreadyComposited: false })).toBe(
      true,
    );
  });
});
