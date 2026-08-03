//
//  HybridBackgroundRenderer.swift
//  VisionCameraBackgroundFilter
//

import AVFoundation
import CoreImage
import CoreVideo
import Foundation
import Metal
import NitroModules
import VisionCamera

/**
 * The live compositor.
 *
 * `renderFrame` is called from the `CameraFrameOutput` thread. The CoreImage
 * context and the Metal command queue are created once and reused — building a
 * `CIContext` per frame is the classic way to turn a 30fps preview into a 5fps one.
 */
final class HybridBackgroundRenderer: HybridBackgroundRendererSpec, NativeSurfaceRenderer {

  private let segmenter = SelfieSegmenter(quality: .balanced)
  private let compositor = BackgroundCompositor()

  private let metalDevice: MTLDevice?
  private let commandQueue: MTLCommandQueue?
  private let ciContext: CIContext?

  /// The layer to present into, handed over by the view.
  private var targetLayer: CAMetalLayer?

  var isSupported: Bool {
    return SelfieSegmenter.isSupported && metalDevice != nil
  }

  var unsupportedReason: String? {
    if let reason = SelfieSegmenter.unsupportedReason {
      return reason.rawValue
    }
    // Every device that runs iOS 15 has Metal, so this is defensive only.
    return metalDevice == nil ? SegmentationUnsupportedReason.unsupportedDevice.rawValue : nil
  }

  override init() {
    let device = MTLCreateSystemDefaultDevice()
    metalDevice = device
    commandQueue = device?.makeCommandQueue()
    if let device {
      // `.workingColorSpace: NSNull` disables CoreImage's colour management for the
      // blend. It is both faster and correct here: the camera frame and the
      // background are already in display space, so a conversion would shift hues.
      ciContext = CIContext(
        mtlDevice: device,
        options: [.workingColorSpace: NSNull(), .cacheIntermediates: false]
      )
    } else {
      ciContext = nil
    }
    super.init()
  }

  /// See `setCameraMirrored`. Written from JS, read on the frame thread.
  private var cameraMirrored = false

  /// The in-flight record-time capture, if any.
  ///
  /// Written from the JS thread (`startCapture` / `stopCapture`), read and fed from
  /// the frame thread — hence the lock. It is held across the whole append so a stop
  /// cannot free the writer out from under a frame already being encoded; the
  /// critical section is one `CIContext.render`, which the frame thread was going to
  /// pay for anyway.
  private var recorder: CompositeRecorder?
  private let recorderLock = NSLock()

  func setBackground(uri: String?, fit: BackgroundFit, mirror: Bool) throws {
    let mode: BackgroundFitMode = fit == .cover ? .cover : .contain
    guard let uri, let image = BackgroundImageLoader.load(uri: uri) else {
      compositor.setBackground(nil, fit: mode, mirror: mirror)
      return
    }
    compositor.setBackground(image, fit: mode, mirror: mirror)
  }

  func setCameraMirrored(mirrored: Bool) throws {
    cameraMirrored = mirrored
  }

  func renderFrame(frame: any HybridFrameSpec) throws {
    guard let layer = targetLayer,
          let ciContext,
          let commandQueue
    else { return }

    guard let nativeFrame = frame as? any NativeFrame else {
      throw RuntimeError.error(withMessage: "Frame is not of type `NativeFrame`!")
    }
    guard let sampleBuffer = nativeFrame.sampleBuffer,
          let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
    else {
      throw RuntimeError.error(withMessage: "Frame does not have a valid pixel buffer!")
    }

    // Camera buffers arrive in SENSOR orientation, not display orientation — on a
    // portrait iPhone the sensor is landscape, so drawing the buffer as-is renders
    // the preview rotated 90°. `frame.orientation` states how the pixel data is
    // rotated relative to upright and it is the consumer's job to counter-rotate;
    // this was the "flipped 90° to the left" bug.
    let cgOrientation = Self.cgOrientation(for: frame.orientation)
    let source = CIImage(cvPixelBuffer: pixelBuffer).oriented(cgOrientation)

    // The SAME orientation goes to Vision, so the mask comes back in the corrected
    // space and lines up with `source`. Passing `.up` here (as this did) also gave
    // the model a sideways person to segment.
    let mask = compositor.hasBackground
      ? segmenter.segment(pixelBuffer: pixelBuffer, orientation: cgOrientation)
      : nil
    // XOR, so the two mirroring sources cannot cancel into a double flip: the
    // consumer asks for a mirrored *presentation*, while `isMirrored` reports that
    // the buffer's own handedness already differs from the output's. Measured on
    // Android, `isMirrored` is false even on a selfie camera whose preview is
    // mirrored, which is why the consumer has to tell us (see the spec).
    let mirrorFrame = cameraMirrored != frame.isMirrored
    let output = compositor.composite(frame: source, mask: mask, mirrorFrame: mirrorFrame)

    // Encode BEFORE presenting: the recorded file is the deliverable, and a frame
    // the encoder was not ready for is lost, whereas a preview frame arriving a
    // millisecond later is not noticeable.
    //
    // The capture composites UNMIRRORED even when the preview is mirrored — exactly
    // as the offline bake and the `expo-camera` path do, so a recording made with
    // the filter matches one made without it. That costs a second `CIBlendWithMask`
    // on the front camera; the expensive part, segmentation, still runs once.
    recorderLock.lock()
    if let recorder {
      let captureImage = mirrorFrame
        ? compositor.composite(frame: source, mask: mask, mirrorFrame: false)
        : output
      recorder.append(
        captureImage,
        at: CMSampleBufferGetPresentationTimeStamp(sampleBuffer),
        using: ciContext
      )
    }
    recorderLock.unlock()

    // Keep the drawable sized to the frame so CoreImage never rescales twice.
    layer.drawableSize = CGSize(width: output.extent.width, height: output.extent.height)
    guard let drawable = layer.nextDrawable(),
          let commandBuffer = commandQueue.makeCommandBuffer()
    else { return }

    let destination = CIRenderDestination(
      width: Int(layer.drawableSize.width),
      height: Int(layer.drawableSize.height),
      pixelFormat: layer.pixelFormat,
      commandBuffer: commandBuffer,
      mtlTextureProvider: { drawable.texture }
    )
    // CoreImage is bottom-left origin, the drawable is top-left; without this the
    // preview would be upside down.
    destination.isFlipped = true

    _ = try? ciContext.startTask(toRender: output, to: destination)
    commandBuffer.present(drawable)
    commandBuffer.commit()
  }

  // MARK: - Record-time capture

  /// `AVAssetWriter` is available on every supported OS; what this really reports is
  /// whether the CoreImage context that renders into it exists.
  var isCaptureSupported: Bool {
    return ciContext != nil
  }

  func startCapture(outputPath: String, maxOutputHeight: Double, aspectRatio: Double) throws {
    guard isCaptureSupported else {
      throw RuntimeError.error(withMessage: "This device cannot encode composited frames.")
    }
    recorderLock.lock()
    defer { recorderLock.unlock() }
    guard recorder == nil else {
      throw RuntimeError.error(withMessage: "A capture is already running.")
    }
    recorder = CompositeRecorder(
      outputPath: outputPath,
      maxOutputHeight: Int(maxOutputHeight),
      aspectRatio: aspectRatio
    )
  }

  func stopCapture() throws -> Promise<String> {
    recorderLock.lock()
    let running = recorder
    recorder = nil
    recorderLock.unlock()

    let promise = Promise<String>()
    guard let running else {
      throw RuntimeError.error(withMessage: "No capture is running.")
    }
    // `finishWriting` is asynchronous and its completion arrives on an AVFoundation
    // queue; the promise is resolved from there rather than blocking the caller.
    running.finish { result in
      switch result {
      case .success(let path):
        promise.resolve(withResult: path)
      case .failure(let error):
        promise.reject(withError: error)
      }
    }
    return promise
  }

  deinit {
    // A screen torn down mid-recording would otherwise leave a writer holding an
    // unfinished file that nothing else knows the path of.
    recorderLock.lock()
    recorder?.cancel()
    recorder = nil
    recorderLock.unlock()
  }

  // MARK: - NativeSurfaceRenderer

  func connectLayer(_ layer: CAMetalLayer) {
    layer.device = metalDevice
    layer.pixelFormat = .bgra8Unorm
    layer.framebufferOnly = false
    // The drawable is sized to the camera frame, but the layer is laid out to the
    // view — and `contentsGravity` defaults to `.resize`, which STRETCHES one onto
    // the other. A 9:16 frame in a view of any other aspect then comes out visibly
    // too wide or too tall, which is not what the unfiltered preview does.
    // `.resizeAspectFill` centre-crops instead, matching VisionCamera's own
    // PreviewView (its `resizeMode` defaults to 'cover').
    layer.contentsGravity = .resizeAspectFill
    targetLayer = layer
  }

  func disconnectLayer() {
    targetLayer = nil
  }

  // MARK: - Background decoding

  /**
   * Maps VisionCamera's `CameraOrientation` to the `CGImagePropertyOrientation`
   * that corrects it.
   *
   * The names line up one-to-one — this is the same mapping VisionCamera itself
   * uses in `CG+CameraOrientation.swift`, reimplemented because that extension is
   * internal to the VisionCamera module and not visible here.
   *
   * Mirroring is deliberately NOT folded in here (no `.leftMirrored` etc.) — it is
   * applied in the compositor instead, so the mask is flipped with the frame.
   *
   * ⚠️ This used to claim "the front camera's buffer already arrives mirrored, so
   * leaving it alone keeps the preview mirror-like". That assumption was **wrong on
   * Android** — the frame output's buffer is not mirrored and `Frame.isMirrored` is
   * `false`, so the filtered preview came out as a mirror image of the unfiltered
   * one. It is unverified on iOS, and is now handled explicitly either way via
   * `setCameraMirrored`. The background stays unmirrored in both the live and offline
   * paths, so only the person is mirrored — as on the `expo-camera` path.
   */
  private static func cgOrientation(for orientation: CameraOrientation) -> CGImagePropertyOrientation {
    switch orientation {
    case .up: return .up
    case .down: return .down
    case .left: return .left
    case .right: return .right
    default: return .up
    }
  }

}

/// Contract between the renderer and the view that hosts its output.
protocol NativeSurfaceRenderer: AnyObject {
  func connectLayer(_ layer: CAMetalLayer)
  func disconnectLayer()
}
