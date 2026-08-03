/**
 * Loads an optional dependency, returning `null` instead of throwing when it is
 * absent or fails to initialise.
 *
 * ## Read this before relying on it
 *
 * **In React Native this does NOT make a dependency optional at build time.**
 * Metro resolves `require` statically while it builds the module graph, so a
 * `require('some-package')` for a package that is not installed is a **bundling
 * error** — the try/catch never runs, because there is no bundle to run it in.
 * The same is true of Webpack and Vite. This is the single most common mistake
 * in "optional peer dependency" code, and it fails at the consumer's build, not
 * ours.
 *
 * What actually makes a dependency optional is **not importing it from a module
 * the consumer loads**. That is why every optional-dependency adapter in this
 * package lives behind its own subpath export (`…/adapters/expo`): a consumer
 * that never imports the subpath never pulls the dependency into the graph, and
 * a consumer that does import it has, by definition, opted into installing it.
 *
 * So what is this for? The narrower, still-real case where the module **resolves
 * but is unusable**: a native module whose autolinking did not run, a package
 * that throws from its top-level initialiser on an unsupported platform, or a
 * version whose entry point has moved. Those fail at require time, at runtime,
 * where a catch can help.
 *
 * @example
 * const fs = optionalRequire(() => require('expo-file-system/legacy'));
 * if (fs == null) return NULL_FILE_SYSTEM;
 */
export function optionalRequire<T>(load: () => T): T | null {
  try {
    return load() ?? null;
  } catch {
    return null;
  }
}
