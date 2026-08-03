import { Image } from 'react-native';

import { BackgroundFilterError } from './BackgroundFilterError';

import type { BackgroundSource } from '../types';

/**
 * Resolves a `BackgroundSource` to a URI the native side can decode.
 *
 * A `require(...)`d asset resolves through the RN asset registry — in dev that is
 * an `http://` Metro URL, in release a bundled `file://`/resource path.
 */
export function resolveBackgroundUri(background: BackgroundSource): string {
  const { source } = background;

  if (typeof source === 'number') {
    const resolved = Image.resolveAssetSource(source);
    if (resolved?.uri == null) {
      throw new BackgroundFilterError(
        'io',
        `Could not resolve the asset for background "${background.id}".`,
      );
    }
    return resolved.uri;
  }

  if (typeof source === 'object' && source != null && 'uri' in source) {
    return source.uri;
  }

  // Unreachable for typed callers; guards JS consumers passing something else.
  throw new BackgroundFilterError(
    'unsupported',
    `Background "${background.id}" has no resolvable URI. Use a require()d asset or a { uri } source.`,
  );
}
