//
//  BackgroundGeometry.swift
//  VisionCameraBackgroundFilter
//
//  Native mirror of `src/composite/geometry.ts`.
//
//  ## Why this exists at all
//
//  The plan's rule is that fit/crop/mirror math lives in exactly one place. A GPU
//  pipeline cannot call TypeScript, and the frame's dimensions are only known
//  natively, so the live and offline composites need this math in-process.
//
//  The rule is preserved as far as it can be:
//  - `geometry.ts` remains the specification, and is unit-tested (36 tests).
//  - This file is the ONLY copy on iOS, shared by the live renderer AND the
//    offline processor — so there are two implementations in total (spec +
//    native), never one per path.
//  - The golden-frame parity test (plan task 7) is what enforces that they agree.
//
//  Keep this in lockstep with `geometry.ts`.
//

import CoreGraphics
import Foundation

enum BackgroundFitMode {
  case cover
  case contain
}

struct BackgroundLayout {
  /// Region of the background to sample, in background pixel coords.
  let source: CGRect
  /// Region of the frame to draw it into, in frame pixel coords.
  let destination: CGRect
}

enum BackgroundGeometry {

  private static let epsilon: CGFloat = 1e-6

  private static func isDegenerate(_ size: CGSize) -> Bool {
    return size.width <= epsilon || size.height <= epsilon
  }

  /// Maps a background onto a frame.
  ///
  /// `cover` crops the background's overflowing axis and fills the frame, so the
  /// destination is always the full frame. `contain` samples the whole background
  /// and letterboxes it centred, so the source is always the full background.
  ///
  /// Degenerate input yields `.zero` rects rather than NaNs — callers draw that as
  /// a no-op.
  static func computeBackgroundLayout(
    background: CGSize,
    frame: CGSize,
    fit: BackgroundFitMode
  ) -> BackgroundLayout {
    if isDegenerate(background) || isDegenerate(frame) {
      return BackgroundLayout(source: .zero, destination: .zero)
    }

    let backgroundRatio = background.width / background.height
    let frameRatio = frame.width / frame.height

    if fit == .cover {
      var cropWidth = background.width
      var cropHeight = background.height
      if backgroundRatio > frameRatio {
        cropWidth = background.height * frameRatio
      } else {
        cropHeight = background.width / frameRatio
      }
      return BackgroundLayout(
        source: CGRect(
          x: (background.width - cropWidth) / 2,
          y: (background.height - cropHeight) / 2,
          width: cropWidth,
          height: cropHeight
        ),
        destination: CGRect(origin: .zero, size: frame)
      )
    }

    var drawWidth = frame.width
    var drawHeight = frame.height
    if backgroundRatio > frameRatio {
      drawHeight = frame.width / backgroundRatio
    } else {
      drawWidth = frame.height * backgroundRatio
    }
    return BackgroundLayout(
      source: CGRect(origin: .zero, size: background),
      destination: CGRect(
        x: (frame.width - drawWidth) / 2,
        y: (frame.height - drawHeight) / 2,
        width: drawWidth,
        height: drawHeight
      )
    )
  }

  /// Flips a rect horizontally inside a container of `containerWidth`.
  static func mirrorRectHorizontally(_ rect: CGRect, containerWidth: CGFloat) -> CGRect {
    return CGRect(
      x: containerWidth - rect.origin.x - rect.width,
      y: rect.origin.y,
      width: rect.width,
      height: rect.height
    )
  }

  /// The affine transform that maps a background image onto the frame under the
  /// given layout — what CoreImage needs to place the background before blending.
  static func backgroundTransform(
    layout: BackgroundLayout,
    backgroundSize: CGSize,
    mirror: Bool
  ) -> CGAffineTransform {
    guard !isDegenerate(layout.source.size), !isDegenerate(layout.destination.size) else {
      return .identity
    }
    let source = mirror
      ? mirrorRectHorizontally(layout.source, containerWidth: backgroundSize.width)
      : layout.source

    let scaleX = layout.destination.width / source.width
    let scaleY = layout.destination.height / source.height

    var transform = CGAffineTransform.identity
    if mirror {
      // Flip about the image's own axis, then translate back into place.
      transform = transform
        .translatedBy(x: backgroundSize.width, y: 0)
        .scaledBy(x: -1, y: 1)
    }
    return transform
      .concatenating(CGAffineTransform(translationX: -source.origin.x, y: -source.origin.y))
      .concatenating(CGAffineTransform(scaleX: scaleX, y: scaleY))
      .concatenating(
        CGAffineTransform(
          translationX: layout.destination.origin.x,
          y: layout.destination.origin.y
        )
      )
  }
}
