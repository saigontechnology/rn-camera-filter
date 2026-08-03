import {
  aspectRatio,
  computeBackgroundLayout,
  fitScale,
  isDegenerate,
  mirrorRectHorizontally,
  normalizeQuarterTurns,
  rotateSize,
} from './geometry';

const PORTRAIT_FRAME = { width: 1080, height: 1920 };
const LANDSCAPE_BG = { width: 1920, height: 1080 };
const PORTRAIT_BG = { width: 1080, height: 1920 };

describe('aspectRatio', () => {
  it('divides width by height', () => {
    expect(aspectRatio({ width: 1920, height: 1080 })).toBeCloseTo(16 / 9);
  });

  it('returns 0 rather than Infinity for a zero height', () => {
    expect(aspectRatio({ width: 100, height: 0 })).toBe(0);
  });
});

describe('isDegenerate', () => {
  it.each([
    [{ width: 0, height: 100 }],
    [{ width: 100, height: 0 }],
    [{ width: -10, height: 100 }],
  ])('flags %p', (size) => {
    expect(isDegenerate(size)).toBe(true);
  });

  it('accepts a positive size', () => {
    expect(isDegenerate(PORTRAIT_FRAME)).toBe(false);
  });
});

describe('computeBackgroundLayout — cover', () => {
  it('fills the whole frame', () => {
    const { destination } = computeBackgroundLayout(LANDSCAPE_BG, PORTRAIT_FRAME, 'cover');
    expect(destination).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
  });

  it('crops the wider axis of a landscape background, centered', () => {
    const { source } = computeBackgroundLayout(LANDSCAPE_BG, PORTRAIT_FRAME, 'cover');
    // frame ratio 9:16 → crop width to 1080 * (9/16) = 607.5, full height.
    expect(source.width).toBeCloseTo(607.5);
    expect(source.height).toBe(1080);
    expect(source.x).toBeCloseTo((1920 - 607.5) / 2);
    expect(source.y).toBe(0);
  });

  it('crops the taller axis when the background is proportionally taller', () => {
    const tallBg = { width: 1080, height: 4000 };
    const { source } = computeBackgroundLayout(tallBg, PORTRAIT_FRAME, 'cover');
    // frame ratio 9:16 → crop height to 1080 / (9/16) = 1920, full width.
    expect(source.width).toBe(1080);
    expect(source.height).toBeCloseTo(1920);
    expect(source.y).toBeCloseTo((4000 - 1920) / 2);
  });

  it('is a no-op crop when aspect ratios already match', () => {
    const { source, destination } = computeBackgroundLayout(PORTRAIT_BG, PORTRAIT_FRAME, 'cover');
    expect(source).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(destination).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
  });

  it('never samples outside the background bounds', () => {
    const { source } = computeBackgroundLayout(LANDSCAPE_BG, PORTRAIT_FRAME, 'cover');
    expect(source.x).toBeGreaterThanOrEqual(0);
    expect(source.y).toBeGreaterThanOrEqual(0);
    expect(source.x + source.width).toBeLessThanOrEqual(LANDSCAPE_BG.width + 1e-6);
    expect(source.y + source.height).toBeLessThanOrEqual(LANDSCAPE_BG.height + 1e-6);
  });

  it('defaults to cover', () => {
    expect(computeBackgroundLayout(LANDSCAPE_BG, PORTRAIT_FRAME)).toEqual(
      computeBackgroundLayout(LANDSCAPE_BG, PORTRAIT_FRAME, 'cover'),
    );
  });
});

describe('computeBackgroundLayout — contain', () => {
  it('samples the entire background', () => {
    const { source } = computeBackgroundLayout(LANDSCAPE_BG, PORTRAIT_FRAME, 'contain');
    expect(source).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('letterboxes a landscape background inside a portrait frame', () => {
    const { destination } = computeBackgroundLayout(LANDSCAPE_BG, PORTRAIT_FRAME, 'contain');
    expect(destination.width).toBe(1080);
    expect(destination.height).toBeCloseTo(1080 / (16 / 9));
    expect(destination.x).toBe(0);
    expect(destination.y).toBeCloseTo((1920 - 1080 / (16 / 9)) / 2);
  });

  it('pillarboxes a very tall background inside a wide frame', () => {
    const { destination } = computeBackgroundLayout(
      { width: 1080, height: 4000 },
      { width: 1920, height: 1080 },
      'contain',
    );
    expect(destination.height).toBe(1080);
    expect(destination.width).toBeCloseTo(1080 * (1080 / 4000));
    expect(destination.y).toBe(0);
    expect(destination.x).toBeGreaterThan(0);
  });

  it('stays inside the frame bounds', () => {
    const { destination } = computeBackgroundLayout(LANDSCAPE_BG, PORTRAIT_FRAME, 'contain');
    expect(destination.x).toBeGreaterThanOrEqual(0);
    expect(destination.y).toBeGreaterThanOrEqual(0);
    expect(destination.x + destination.width).toBeLessThanOrEqual(PORTRAIT_FRAME.width + 1e-6);
    expect(destination.y + destination.height).toBeLessThanOrEqual(PORTRAIT_FRAME.height + 1e-6);
  });
});

describe('computeBackgroundLayout — degenerate inputs', () => {
  const empty = {
    source: { x: 0, y: 0, width: 0, height: 0 },
    destination: { x: 0, y: 0, width: 0, height: 0 },
  };

  it('returns an empty layout for a zero-sized background', () => {
    expect(computeBackgroundLayout({ width: 0, height: 0 }, PORTRAIT_FRAME)).toEqual(empty);
  });

  it('returns an empty layout for a zero-sized frame', () => {
    expect(computeBackgroundLayout(LANDSCAPE_BG, { width: 1080, height: 0 })).toEqual(empty);
  });

  it('never produces NaN', () => {
    const { source, destination } = computeBackgroundLayout(
      { width: 0, height: 100 },
      PORTRAIT_FRAME,
    );
    [...Object.values(source), ...Object.values(destination)].forEach((n) => {
      expect(Number.isNaN(n)).toBe(false);
    });
  });
});

describe('mirrorRectHorizontally', () => {
  it('flips a rect about the container mid-line', () => {
    expect(mirrorRectHorizontally({ x: 10, y: 5, width: 30, height: 40 }, 100)).toEqual({
      x: 60,
      y: 5,
      width: 30,
      height: 40,
    });
  });

  it('leaves a full-width rect in place', () => {
    const full = { x: 0, y: 0, width: 100, height: 50 };
    expect(mirrorRectHorizontally(full, 100)).toEqual(full);
  });

  it('is its own inverse', () => {
    const rect = { x: 12, y: 3, width: 25, height: 9 };
    expect(mirrorRectHorizontally(mirrorRectHorizontally(rect, 200), 200)).toEqual(rect);
  });
});

describe('normalizeQuarterTurns', () => {
  it.each([
    [0, 0],
    [1, 1],
    [4, 0],
    [5, 1],
    [-1, 3],
    [-4, 0],
    [7, 3],
  ])('normalizes %i to %i', (input, expected) => {
    expect(normalizeQuarterTurns(input)).toBe(expected);
  });
});

describe('rotateSize', () => {
  it('swaps axes on odd quarter turns', () => {
    expect(rotateSize(LANDSCAPE_BG, 1)).toEqual({ width: 1080, height: 1920 });
    expect(rotateSize(LANDSCAPE_BG, 3)).toEqual({ width: 1080, height: 1920 });
  });

  it('preserves axes on even quarter turns', () => {
    expect(rotateSize(LANDSCAPE_BG, 0)).toEqual(LANDSCAPE_BG);
    expect(rotateSize(LANDSCAPE_BG, 2)).toEqual(LANDSCAPE_BG);
  });

  it('normalizes out-of-range turns', () => {
    expect(rotateSize(LANDSCAPE_BG, -1)).toEqual({ width: 1080, height: 1920 });
  });
});

describe('fitScale', () => {
  it('takes the larger axis scale for cover', () => {
    expect(fitScale(LANDSCAPE_BG, PORTRAIT_FRAME, 'cover')).toBeCloseTo(1920 / 1080);
  });

  it('takes the smaller axis scale for contain', () => {
    expect(fitScale(LANDSCAPE_BG, PORTRAIT_FRAME, 'contain')).toBeCloseTo(1080 / 1920);
  });

  it('returns 0 for degenerate sizes instead of Infinity', () => {
    expect(fitScale({ width: 0, height: 0 }, PORTRAIT_FRAME)).toBe(0);
    expect(fitScale(LANDSCAPE_BG, { width: 0, height: 0 })).toBe(0);
  });

  it('agrees with the cover layout it describes', () => {
    // A cover layout crops the background, then scales the crop up to the frame.
    const { source } = computeBackgroundLayout(LANDSCAPE_BG, PORTRAIT_FRAME, 'cover');
    const scale = fitScale(LANDSCAPE_BG, PORTRAIT_FRAME, 'cover');
    expect(source.width * scale).toBeCloseTo(PORTRAIT_FRAME.width);
    expect(source.height * scale).toBeCloseTo(PORTRAIT_FRAME.height);
  });
});
