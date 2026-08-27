package com.saigontechnology.backgroundfilter

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.margelo.nitro.NitroModules
import java.io.File
import java.net.URI
import java.net.URL

/**
 * Background decoding, shared by the live renderer and the offline bake.
 *
 * The Android counterpart of `ios/BackgroundImageLoader.swift`, and it exists for
 * the same reason: both paths MUST load a background the same way, or the preview
 * and the delivered file disagree about the very pixels this feature exists to
 * composite. The two used to carry a private copy of this each, which is how the
 * resource branch below came to be missing from both.
 */
object BackgroundImageLoader {

  /**
   * Longest edge a decoded background is allowed to keep, in pixels.
   *
   * Mirrors `MAX_BACKGROUND_EDGE_PX` in `src/assets/background/index.ts`.
   * Duplicated because native cannot read the TS constant; keep them in step.
   *
   * The downscale is not an optimisation, it is a correctness requirement: an
   * 8192x5464 source decodes to ~171 MB of RGBA — an OOM on mid-range devices —
   * and exceeds the 4096px `GL_MAX_TEXTURE_SIZE` many GPUs report, which makes the
   * texture upload fail outright. Consumers can inject arbitrary images, so this
   * cannot rely on assets being well-sized.
   */
  const val MAX_BACKGROUND_EDGE_PX = 1920

  /**
   * Decodes a background from any URI form the JS side can produce.
   *
   * Returns null on any failure — callers then draw the camera frame unmodified
   * rather than a broken composite, and never log.
   */
  fun load(uri: String): Bitmap? =
    runCatching {
      val bytes = readBytes(uri) ?: return null

      // Two passes: measure, then decode subsampled. `inSampleSize` only honours
      // powers of two, so this lands at or below the cap, never above it.
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)

      var sampleSize = 1
      while (maxOf(bounds.outWidth, bounds.outHeight) / sampleSize > MAX_BACKGROUND_EDGE_PX) {
        sampleSize *= 2
      }

      BitmapFactory.decodeByteArray(
        bytes,
        0,
        bytes.size,
        BitmapFactory.Options().apply { inSampleSize = sampleSize },
      )
    }.getOrNull()

  /**
   * Reads the bytes behind a background URI.
   *
   * The forms `Image.resolveAssetSource` can hand back for a `require()`d asset,
   * plus the `{ uri }` sources a consumer may inject:
   *
   * | Form                                  | Where it comes from                    |
   * | ------------------------------------- | -------------------------------------- |
   * | `http://10.0.2.2:8081/assets/…`       | Metro, in a dev build                  |
   * | `file:///…` / `/data/…`               | an injected `{ uri }`, a cached file   |
   * | `assets_…_bgoffice` (no scheme, no /) | **a RELEASE build's drawable resource** |
   *
   * That last row is the one that used to be missing, and its absence is invisible
   * in every dev build. React Native packages `require()`d images into
   * `res/drawable-*` for release Android builds and resolves them by RESOURCE
   * IDENTIFIER — `AssetSourceResolver.resourceIdentifierWithoutScale`, e.g.
   * `packages_visioncamerabackgroundfilter_src_assets_background_bgoffice`. There is
   * no file at that path, so `File(uri).readBytes()` threw, `load` swallowed it, and
   * the renderer composited a null background: the filter silently did nothing on
   * every release APK, in the preview AND in the offline bake, while a dev build
   * (Metro serves an `http://` URL) worked perfectly. iOS is unaffected — its
   * release assets stay real files in the bundle.
   */
  private fun readBytes(uri: String): ByteArray? =
    when {
      uri.startsWith("http://") || uri.startsWith("https://") ->
        URL(uri).openStream().use { it.readBytes() }

      uri.startsWith("file://") -> File(URI(uri)).readBytes()

      else -> {
        // A path is tried first so an injected absolute path keeps working exactly
        // as it did; the resource lookup is a fallback, not a replacement.
        val file = File(uri)
        if (file.isFile) file.readBytes() else readDrawableResource(uri)
      }
    }

  /**
   * Reads a drawable resource by name, as the JS asset registry addresses it.
   *
   * `openRawResource` returns the packaged file's own bytes — AAPT stores a jpg/png
   * in `res/drawable-*` verbatim rather than compiling it — so this feeds
   * `BitmapFactory` the same bytes every other branch does, and the density
   * qualifier is resolved by the resource system.
   */
  private fun readDrawableResource(name: String): ByteArray? {
    val context: Context = NitroModules.applicationContext ?: return null
    val resources = context.resources
    val id = resources.getIdentifier(name, "drawable", context.packageName)
    if (id == 0) return null
    return resources.openRawResource(id).use { it.readBytes() }
  }
}
