//
//  BackgroundImageLoader.swift
//  VisionCameraBackgroundFilter
//
//  Background decoding, shared by the live renderer and the offline bake.
//
//  Both paths MUST load a background the same way, or the preview and the delivered
//  file disagree about the very pixels this feature exists to composite. Keeping the
//  decode (and its downscale) in one place is part of the same argument as
//  `BackgroundGeometry`: two implementations, spec + native, never one per path.
//

import CoreImage
import Foundation

enum BackgroundImageLoader {

  /**
   * Longest edge a decoded background may keep.
   *
   * Mirrors `MAX_BACKGROUND_EDGE_PX` in `src/assets/background/index.ts`.
   * Duplicated because native cannot read the TS constant; keep them in step.
   */
  static let maxEdgePx: CGFloat = 1920

  /**
   * Decodes a background from the URI forms the JS side can produce: a `file://` or
   * absolute path in release, and an `http://` Metro URL in dev.
   *
   * Returns nil on any failure — callers then draw the unmodified frame rather than
   * a broken composite, and never log.
   */
  static func load(uri: String) -> CIImage? {
    let image: CIImage?
    if uri.hasPrefix("http://") || uri.hasPrefix("https://") {
      guard let url = URL(string: uri),
            let data = try? Data(contentsOf: url)
      else { return nil }
      image = CIImage(data: data)
    } else {
      let url = uri.hasPrefix("file://") ? URL(string: uri) : URL(fileURLWithPath: uri)
      guard let url else { return nil }
      image = CIImage(contentsOf: url)
    }

    guard let image else { return nil }
    return downscaleIfNeeded(image)
  }

  /**
   * Scales an oversized background down once, at load.
   *
   * The bundled images reach 8192x5464. CoreImage is lazy enough to survive that,
   * but every render pass would then sample a texture ~18x larger than the frame it
   * composites into — per frame, for every frame of an offline bake.
   */
  static func downscaleIfNeeded(_ image: CIImage) -> CIImage {
    let extent = image.extent
    guard extent.width > 0, extent.height > 0 else { return image }
    let longest = max(extent.width, extent.height)
    guard longest > maxEdgePx else { return image }
    let scale = maxEdgePx / longest
    return image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
  }
}
