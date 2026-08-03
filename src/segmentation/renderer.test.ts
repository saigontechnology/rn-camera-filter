import { NitroModules } from 'react-native-nitro-modules';

import {
  getBackgroundRenderer,
  getSegmentationSupport,
  resetBackgroundRendererCache,
  tryGetBackgroundRenderer,
} from './renderer';

import type { BackgroundRenderer } from '../specs/BackgroundRenderer.nitro';

const hasHybridObject = NitroModules.hasHybridObject as jest.Mock;
const createHybridObject = NitroModules.createHybridObject as jest.Mock;

const renderer = (overrides: Partial<BackgroundRenderer>) =>
  ({ isSupported: true, ...overrides }) as BackgroundRenderer;

describe('background renderer resolution', () => {
  beforeEach(() => {
    resetBackgroundRendererCache();
    hasHybridObject.mockReset();
    createHybridObject.mockReset();
  });

  it('returns null when the hybrid object is not registered', () => {
    hasHybridObject.mockReturnValue(false);
    expect(tryGetBackgroundRenderer()).toBeNull();
    expect(createHybridObject).not.toHaveBeenCalled();
  });

  it('returns null instead of throwing when creation blows up', () => {
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockImplementation(() => {
      throw new Error('no native side');
    });
    expect(tryGetBackgroundRenderer()).toBeNull();
  });

  it('caches the instance so the live path does not recreate it per frame', () => {
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(renderer({}));
    tryGetBackgroundRenderer();
    tryGetBackgroundRenderer();
    tryGetBackgroundRenderer();
    expect(createHybridObject).toHaveBeenCalledTimes(1);
  });

  it('throws a BackgroundFilterError from the non-degrading accessor', () => {
    hasHybridObject.mockReturnValue(false);
    expect(() => getBackgroundRenderer()).toThrow(
      expect.objectContaining({ name: 'BackgroundFilterError', code: 'unsupported' }),
    );
  });
});

describe('getSegmentationSupport', () => {
  beforeEach(() => {
    resetBackgroundRendererCache();
    hasHybridObject.mockReset();
    createHybridObject.mockReset();
  });

  it('reports "no-model" when the native module is absent', () => {
    hasHybridObject.mockReturnValue(false);
    expect(getSegmentationSupport()).toEqual({ supported: false, reason: 'no-model' });
  });

  it('passes the native reason through', () => {
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(
      renderer({ isSupported: false, unsupportedReason: 'os-version' }),
    );
    expect(getSegmentationSupport()).toEqual({ supported: false, reason: 'os-version' });
  });

  it('falls back to "unsupported-device" when native gives no reason', () => {
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(renderer({ isSupported: false }));
    expect(getSegmentationSupport()).toEqual({
      supported: false,
      reason: 'unsupported-device',
    });
  });

  it('reports supported with no reason on a capable device', () => {
    hasHybridObject.mockReturnValue(true);
    createHybridObject.mockReturnValue(renderer({}));
    expect(getSegmentationSupport()).toEqual({ supported: true });
  });
});
