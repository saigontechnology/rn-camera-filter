//
//  BackgroundCompositor.swift
//  VisionCameraBackgroundFilter
//
//  The blend itself, shared by the live renderer and the offline bake.
//
//  Both iOS paths run the SAME CoreImage graph — `CIBlendWithMask` over the same
//  geometry from `BackgroundGeometry` — which is what makes preview/output parity
//  structural on this platform rather than something to test our way into. The
//  only intended difference is segmentation quality (`.balanced` live,
//  `.accurate` offline).
//

import CoreImage
import CoreVideo
import Foundation

final class BackgroundCompositor {

  private var background: CIImage?
  private var fit: BackgroundFitMode = .cover
  private var mirror: Bool = false

  /// Replaces the background. Pass `nil` to clear it.
  func setBackground(_ image: CIImage?, fit: BackgroundFitMode, mirror: Bool) {
    self.background = image
    self.fit = fit
    self.mirror = mirror
  }

  var hasBackground: Bool {
    return background != nil
  }

  /// Composites `frame` over the configured background using `mask`.
  ///
  /// Returns `frame` unchanged when there is no background or no mask — a frame
  /// that failed to segment must draw as itself, never as a stale silhouette and
  /// never as nothing.
  ///
  /// `mirrorFrame` flips the camera **and its mask** horizontally, never the
  /// background. Both are flipped here, in one place, so they cannot drift apart —
  /// a mirrored frame blended with an unmirrored mask would put the silhouette on
  /// the wrong side of the subject. The flip is applied before the guards above, so
  /// a frame that fails to segment is still mirrored and does not flash unflipped.
  /// The offline bake leaves this `false`: recorded files are not mirrored.
  func composite(frame rawFrame: CIImage, mask: CVPixelBuffer?, mirrorFrame: Bool = false) -> CIImage {
    let frame = mirrorFrame ? Self.mirroredHorizontally(rawFrame) : rawFrame

    guard let background else { return frame }
    guard let mask else { return frame }

    let frameExtent = frame.extent
    let backgroundExtent = background.extent
    guard !frameExtent.isEmpty, !backgroundExtent.isEmpty else { return frame }

    let layout = BackgroundGeometry.computeBackgroundLayout(
      background: backgroundExtent.size,
      frame: frameExtent.size,
      fit: fit
    )
    let transform = BackgroundGeometry.backgroundTransform(
      layout: layout,
      backgroundSize: backgroundExtent.size,
      mirror: mirror
    )

    // Clamping before the transform stops CoreImage sampling transparent black at
    // the edges, which would show as a dark seam on a `cover` crop.
    let placedBackground = background
      .clampedToExtent()
      .transformed(by: transform)
      .cropped(to: frameExtent)

    // Vision's mask is usually smaller than the frame; scale it up to match, or
    // the blend would only cover a corner.
    let maskImage = CIImage(cvPixelBuffer: mask)
    let maskExtent = maskImage.extent
    guard !maskExtent.isEmpty else { return frame }
    let scaledMask = maskImage.transformed(
      by: CGAffineTransform(
        scaleX: frameExtent.width / maskExtent.width,
        y: frameExtent.height / maskExtent.height
      )
    )

    // Mirrored to match the frame above. The mask is scaled to `frameExtent` first,
    // so flipping about that extent's centre lands it exactly on the flipped frame.
    let orientedMask = mirrorFrame ? Self.mirroredHorizontally(scaledMask, in: frameExtent) : scaledMask

    let blend = CIFilter(name: "CIBlendWithMask")
    blend?.setValue(frame, forKey: kCIInputImageKey)
    blend?.setValue(placedBackground, forKey: kCIInputBackgroundImageKey)
    blend?.setValue(orientedMask, forKey: kCIInputMaskImageKey)
    return blend?.outputImage ?? frame
  }

  /// Flips `image` horizontally about its own extent's centre.
  private static func mirroredHorizontally(_ image: CIImage) -> CIImage {
    return mirroredHorizontally(image, in: image.extent)
  }

  /// Flips `image` horizontally about the centre of `extent`.
  private static func mirroredHorizontally(_ image: CIImage, in extent: CGRect) -> CIImage {
    guard !extent.isEmpty else { return image }
    // x' = -x + 2*midX, i.e. scale by -1 on X then translate back into place.
    let flip = CGAffineTransform(scaleX: -1, y: 1)
      .concatenating(CGAffineTransform(translationX: extent.midX * 2, y: 0))
    return image.transformed(by: flip)
  }
}
