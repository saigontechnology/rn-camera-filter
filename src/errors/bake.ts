import { isBackgroundFilterError } from '../util/BackgroundFilterError';

/**
 * Thrown to unwind a submit pipeline after the user cancels a bake.
 *
 * The bake typically sits in the middle of an upload sequence, and the only way
 * out of the middle of a sequence is to throw — but a cancel is not a failure,
 * and showing it as one ("Upload failed") both misinforms the user and hides real
 * failures behind an outcome they will assume they caused. This type is what lets
 * the caller tell the two apart at the top of the stack.
 */
export class BakeCancelledError extends Error {
  constructor(message = 'The background bake was cancelled.') {
    super(message);
    this.name = 'BakeCancelledError';
  }
}

/** Type guard for {@link BakeCancelledError}. */
export const isBakeCancelled = (error: unknown): error is BakeCancelledError =>
  error instanceof BakeCancelledError;

/**
 * Whether a rejection from `processVideoBackground` was a cancellation.
 *
 * Distinct from {@link isBakeCancelled}: this inspects the package's own
 * `BackgroundFilterError` at the point the bake rejects, **before** it has been
 * converted into the caller's sentinel. Getting these backwards silently
 * reclassifies every genuine encoder failure as "you cancelled", which swallows
 * the failure entirely.
 */
export const isCancelledBakeError = (error: unknown): boolean =>
  isBackgroundFilterError(error) && error.code === 'cancelled';

/**
 * How a bake failure should be presented, collapsed to the three cases a user
 * interface actually distinguishes.
 *
 * The package ships no copy — it has no i18n and no opinion on tone — so this is
 * the seam: map the reason to your own string. Kept coarser than
 * `BackgroundFilterErrorCode` because `decode-failed`, `encode-failed` and `io`
 * all mean the same thing to a user ("it didn't work, try again"), and a UI that
 * distinguishes them is leaking implementation detail into its copy.
 */
export type BakeFailureReason = 'unsupported' | 'cancelled' | 'failed';

/**
 * Classifies a bake rejection.
 *
 * Anything unrecognised — a plain `Error`, a future error code — reports
 * `'failed'`, so a new code can never surface untranslated.
 *
 * @example
 * const KEYS: Record<BakeFailureReason, string> = {
 *   unsupported: 'video.bakeUnsupported',
 *   cancelled: 'video.bakeCancelled',
 *   failed: 'video.bakeFailed',
 * };
 * toast.error(t(KEYS[bakeFailureReason(error)]));
 */
export const bakeFailureReason = (error: unknown): BakeFailureReason => {
  if (isBakeCancelled(error)) return 'cancelled';
  if (!isBackgroundFilterError(error)) return 'failed';

  switch (error.code) {
    case 'unsupported':
      return 'unsupported';
    case 'cancelled':
      return 'cancelled';
    case 'decode-failed':
    case 'encode-failed':
    case 'io':
      return 'failed';
    default:
      return 'failed';
  }
};
