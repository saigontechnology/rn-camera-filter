export type BackgroundFilterErrorCode =
  'unsupported' | 'decode-failed' | 'encode-failed' | 'cancelled' | 'io';

/**
 * The only error type this package rejects with. Consumers map `code` to their
 * own user-facing copy — the package never renders or logs anything itself.
 */
export class BackgroundFilterError extends Error {
  readonly code: BackgroundFilterErrorCode;

  constructor(code: BackgroundFilterErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'BackgroundFilterError';
    this.code = code;
    // Restore the prototype chain across the ES5 target transpilation, so
    // `err instanceof BackgroundFilterError` holds for consumers.
    Object.setPrototypeOf(this, BackgroundFilterError.prototype);
  }
}

export const isBackgroundFilterError = (err: unknown): err is BackgroundFilterError =>
  err instanceof BackgroundFilterError;
