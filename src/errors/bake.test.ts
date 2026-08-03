import {
  BakeCancelledError,
  bakeFailureReason,
  isBakeCancelled,
  isCancelledBakeError,
} from './bake';
import { BackgroundFilterError } from '../util/BackgroundFilterError';

describe('isBakeCancelled', () => {
  it('recognises the sentinel', () => {
    expect(isBakeCancelled(new BakeCancelledError())).toBe(true);
  });

  it.each([new Error('nope'), new BackgroundFilterError('cancelled', 'x'), null, undefined])(
    'rejects %s',
    (error) => {
      expect(isBakeCancelled(error)).toBe(false);
    },
  );
});

describe('isCancelledBakeError', () => {
  // This is the pre-conversion check, against the package's own error. Confusing
  // it with `isBakeCancelled` reclassifies every genuine encoder failure as a
  // user cancel, which swallows the failure entirely — hence both directions.
  it('recognises a cancelled BackgroundFilterError', () => {
    expect(isCancelledBakeError(new BackgroundFilterError('cancelled', 'x'))).toBe(true);
  });

  it('does NOT treat an encode failure as a cancel', () => {
    expect(isCancelledBakeError(new BackgroundFilterError('encode-failed', 'x'))).toBe(false);
  });

  it('does not recognise the post-conversion sentinel', () => {
    expect(isCancelledBakeError(new BakeCancelledError())).toBe(false);
  });
});

describe('bakeFailureReason', () => {
  it.each([
    ['unsupported', 'unsupported'],
    ['cancelled', 'cancelled'],
    ['decode-failed', 'failed'],
    ['encode-failed', 'failed'],
    ['io', 'failed'],
  ] as const)('maps %s to %s', (code, expected) => {
    expect(bakeFailureReason(new BackgroundFilterError(code, 'x'))).toBe(expected);
  });

  it('maps the cancel sentinel to cancelled', () => {
    expect(bakeFailureReason(new BakeCancelledError())).toBe('cancelled');
  });

  // An unrecognised rejection must never surface untranslated, so everything
  // unknown collapses to the generic failure rather than falling through.
  it.each([new Error('boom'), 'a string', null, undefined])('maps %s to failed', (error) => {
    expect(bakeFailureReason(error)).toBe('failed');
  });
});
