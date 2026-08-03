//
//  SelfieSegmenter.swift
//  VisionCameraBackgroundFilter
//
//  The segmentation core. Deliberately NOT a Nitro HybridObject: no mask ever
//  crosses into JS. Both the live renderer and the offline bake own an instance
//  and call `segment` directly, which is what keeps the two paths producing
//  identical masks.
//

import CoreVideo
import Foundation
import Vision

/// How much time the segmenter may spend on a frame.
enum SegmentationQuality {
  /// Live preview — must fit inside a frame interval.
  case balanced
  /// Offline bake — no frame deadline, so we can afford the better model.
  case accurate

  var requestLevel: VNGeneratePersonSegmentationRequest.QualityLevel {
    switch self {
    case .balanced: return .balanced
    case .accurate: return .accurate
    }
  }
}

enum SegmentationUnsupportedReason: String {
  case osVersion = "os-version"
  case noModel = "no-model"
  case unsupportedDevice = "unsupported-device"
}

final class SelfieSegmenter {
  /// `VNGeneratePersonSegmentationRequest` is iOS 15+.
  static var isSupported: Bool {
    if #available(iOS 15.0, *) {
      return true
    }
    return false
  }

  static var unsupportedReason: SegmentationUnsupportedReason? {
    isSupported ? nil : .osVersion
  }

  /// Reused across frames — `VNSequenceRequestHandler` keeps Vision's internal
  /// state warm, which is the difference between hitting 30fps and not.
  private let sequenceHandler = VNSequenceRequestHandler()
  private let request: VNGeneratePersonSegmentationRequest?

  init(quality: SegmentationQuality) {
    if #available(iOS 15.0, *) {
      let request = VNGeneratePersonSegmentationRequest()
      request.qualityLevel = quality.requestLevel
      // One-channel 8-bit mask: the cheapest format Vision offers that a GPU
      // sampler can read directly.
      request.outputPixelFormat = kCVPixelFormatType_OneComponent8
      self.request = request
    } else {
      self.request = nil
    }
  }

  /// Segments a pixel buffer.
  ///
  /// Returns a mask `CVPixelBuffer` (`kCVPixelFormatType_OneComponent8`, 1.0 =
  /// person) whose dimensions may be SMALLER than the input — Vision picks its
  /// own working resolution. Callers must scale it when sampling, never assume
  /// it matches the frame.
  ///
  /// Returns `nil` when no person was found or the request failed; callers draw
  /// the unmodified frame in that case rather than reusing a stale mask, which
  /// would smear the previous frame's silhouette.
  func segment(pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation) -> CVPixelBuffer? {
    guard let request else { return nil }
    do {
      try sequenceHandler.perform([request], on: pixelBuffer, orientation: orientation)
      guard let result = request.results?.first else { return nil }
      return result.pixelBuffer
    } catch {
      // Swallowed on purpose: a failed frame must not tear down the pipeline,
      // and the package does not log. The caller falls back to the raw frame.
      return nil
    }
  }
}
