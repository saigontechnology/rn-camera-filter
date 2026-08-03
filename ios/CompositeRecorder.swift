//
//  CompositeRecorder.swift
//  VisionCameraBackgroundFilter
//
//  Encodes the composited preview frames to a video-only file, as they are drawn.
//

import AVFoundation
import CoreImage
import CoreVideo
import Foundation

/**
 * A video-only `AVAssetWriter` fed from the live compositor.
 *
 * This is the record-time half of the "what you see is what you upload" path: the
 * renderer hands over the very `CIImage` it just drew, so the file cannot disagree
 * with the preview about framing, segmentation, or the background — there is only
 * one composite.
 *
 * **No audio, by construction.** The microphone belongs to the capture session,
 * whose samples go to VisionCamera's `Recorder`. That recorder runs alongside this
 * one and its audio track is remuxed onto this file afterwards
 * (`HybridOfflineVideoProcessor.muxAudio`), so nothing here ever owns A/V sync.
 *
 * Threading: `append` is called from the frame-delivery thread and nothing else
 * touches the writer while it runs — the renderer holds a lock across the whole
 * capture section, and `finish` takes the same lock.
 */
final class CompositeRecorder {

  enum Failure: Error {
    case writerFailed(String)
    case noFrames
  }

  /// Bits per pixel per FRAME. 0.15 puts 1080x1920@30 near 9 Mbps — enough headroom
  /// for a talking head without inflating a clip that is about to be uploaded.
  ///
  /// Note the unit: this was briefly "bits per pixel per second" AND multiplied by
  /// the frame rate, asking the encoder for well over 100 Mbps.
  private static let bitsPerPixelPerFrame: Double = 0.15
  private static let assumedFrameRate: Double = 30

  private let outputURL: URL
  private let maxOutputHeight: Int
  /**
   * Width/height the recording should have, or 0 to take the frame's own.
   *
   * The frames being composited are shaped for the PREVIEW — the frame output matches
   * the preview's aspect so the filtered preview does not show a different field of
   * view than the unfiltered one — while the camera's own recorder writes its own
   * shape. Without this a filtered recording would come out a different shape than an
   * unfiltered one.
   */
  private let aspectRatio: Double

  private var writer: AVAssetWriter?
  private var input: AVAssetWriterInput?
  private var adaptor: AVAssetWriterInputPixelBufferAdaptor?

  /// The session's zero point. Frame timestamps are camera-supplied and start at an
  /// arbitrary host time, so everything is written relative to the first frame.
  private var startTime: CMTime?
  private var lastTime: CMTime = .zero
  private var outputSize: CGSize = .zero
  private var appended = 0
  /// Frames the encoder was not ready for. Reported nowhere, but a non-zero count
  /// is the first thing to look at if a capture plays back jerky.
  private(set) var dropped = 0

  init(outputPath: String, maxOutputHeight: Int, aspectRatio: Double) {
    self.outputURL = Self.fileURL(from: outputPath)
    self.maxOutputHeight = maxOutputHeight
    self.aspectRatio = aspectRatio
  }

  /**
   * Encodes one composited frame.
   *
   * The writer is configured lazily, from the first frame — its dimensions are not
   * known until then, and asking the camera would only duplicate the renderer's own
   * orientation handling.
   *
   * A frame the encoder is not ready for is dropped rather than queued: this runs on
   * the frame-delivery thread, and blocking it would stall the preview the user is
   * watching. Timestamps are absolute, so a dropped frame simply extends its
   * predecessor's on-screen time instead of shifting the rest of the clip.
   */
  func append(_ image: CIImage, at time: CMTime, using ciContext: CIContext) {
    guard time.isValid, !image.extent.isEmpty else { return }

    if writer == nil {
      guard configure(for: image.extent.size) else { return }
    }
    guard let writer, let input, let adaptor, writer.status == .writing else { return }

    let start: CMTime
    if let startTime {
      start = startTime
    } else {
      start = time
      startTime = time
      writer.startSession(atSourceTime: .zero)
    }
    // A non-monotonic timestamp would be rejected by the writer and abort the whole
    // capture, so it is dropped instead. Cheap insurance: the camera should never
    // emit one, but "should never" is how the orientation bugs started too.
    let elapsed = CMTimeSubtract(time, start)
    if appended > 0, CMTimeCompare(elapsed, lastTime) <= 0 { return }

    guard input.isReadyForMoreMediaData else {
      dropped += 1
      return
    }
    guard let pool = adaptor.pixelBufferPool else { return }

    var buffer: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &buffer) == kCVReturnSuccess,
          let buffer
    else { return }

    // Scale only when the cap actually bit; `scaled` is the identity otherwise.
    let scaled = Self.scaled(image, to: outputSize)
    ciContext.render(scaled, to: buffer)

    if adaptor.append(buffer, withPresentationTime: elapsed) {
      appended += 1
      lastTime = elapsed
    }
  }

  /**
   * Finishes the file and hands back its path.
   *
   * A capture that never encoded a frame is a failure, not an empty success: the
   * consumer would otherwise upload a file that plays as nothing. The partial file
   * is removed on every failing path, since the caller only ever learns the path
   * when this succeeds and so cannot clean it up itself.
   */
  func finish(completion: @escaping (Result<String, Error>) -> Void) {
    guard let writer, let input, appended > 0 else {
      cancel()
      completion(.failure(Failure.noFrames))
      return
    }

    input.markAsFinished()
    writer.endSession(atSourceTime: lastTime)
    writer.finishWriting { [outputURL] in
      if writer.status == .completed {
        completion(.success(outputURL.path))
      } else {
        try? FileManager.default.removeItem(at: outputURL)
        let message = writer.error?.localizedDescription ?? "The capture could not be written."
        completion(.failure(Failure.writerFailed(message)))
      }
    }
    self.writer = nil
    self.input = nil
    self.adaptor = nil
  }

  /// Tears the capture down and deletes whatever was written. Safe to call twice.
  func cancel() {
    if let writer, writer.status == .writing {
      writer.cancelWriting()
    }
    writer = nil
    input = nil
    adaptor = nil
    try? FileManager.default.removeItem(at: outputURL)
  }

  // MARK: - Setup

  private func configure(for size: CGSize) -> Bool {
    let target = Self.capped(
      Self.cropped(size, toAspect: aspectRatio),
      maxHeight: maxOutputHeight
    )
    guard target.width >= 2, target.height >= 2 else { return false }

    try? FileManager.default.removeItem(at: outputURL)
    guard let writer = try? AVAssetWriter(outputURL: outputURL, fileType: .mp4) else { return false }

    let pixelCount = Double(Int(target.width) * Int(target.height))
    let settings: [String: Any] = [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: Int(target.width),
      AVVideoHeightKey: Int(target.height),
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: Int(
          pixelCount * Self.assumedFrameRate * Self.bitsPerPixelPerFrame
        ),
        // One keyframe a second, matching the offline bake, so a trim can cut
        // close to where the user dropped the handle.
        AVVideoMaxKeyFrameIntervalKey: 30,
      ],
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    // The frame thread appends synchronously; there is no pull-style writer queue.
    input.expectsMediaDataInRealTime = true
    guard writer.canAdd(input) else { return false }
    writer.add(input)

    let adaptor = AVAssetWriterInputPixelBufferAdaptor(
      assetWriterInput: input,
      sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: Int(target.width),
        kCVPixelBufferHeightKey as String: Int(target.height),
        // CoreImage renders through Metal; without this the pool hands back buffers
        // it cannot draw into and every frame silently fails to append.
        kCVPixelBufferMetalCompatibilityKey as String: true,
      ]
    )
    guard writer.startWriting() else { return false }

    self.writer = writer
    self.input = input
    self.adaptor = adaptor
    self.outputSize = target
    return true
  }

  /// The largest region of `size` with the given width/height ratio, i.e. a centre
  /// crop. `aspect <= 0` keeps the frame's own shape.
  private static func cropped(_ size: CGSize, toAspect aspect: Double) -> CGSize {
    guard aspect > 0, size.width > 0, size.height > 0 else { return size }
    let frameAspect = size.width / size.height
    return frameAspect > aspect
      ? CGSize(width: size.height * aspect, height: size.height)  // too wide — narrow it
      : CGSize(width: size.width, height: size.width / aspect)
  }

  /// Fits `size` under `maxHeight` on its longer edge, rounded to even dimensions
  /// (H.264 encoders reject odd ones). `maxHeight <= 0` keeps the source size.
  private static func capped(_ size: CGSize, maxHeight: Int) -> CGSize {
    let longest = max(size.width, size.height)
    let cap = Double(maxHeight)
    let scale = cap > 0 && longest > cap ? cap / longest : 1
    return CGSize(width: even(size.width * scale), height: even(size.height * scale))
  }

  private static func even(_ value: Double) -> Double {
    let rounded = Int(value.rounded())
    return Double(rounded % 2 == 0 ? rounded : rounded - 1)
  }

  /// Centre-crops `image` to `size`'s aspect and scales it to fill exactly — the same
  /// cover-crop the preview does, so the recording is a reframing of what was on
  /// screen and never a squashed copy of it.
  private static func scaled(_ image: CIImage, to size: CGSize) -> CIImage {
    let extent = image.extent
    guard !extent.isEmpty, size.width > 0, size.height > 0 else { return image }

    // The writer expects the image to start at (0,0); a composited frame can carry a
    // non-zero extent origin.
    let atOrigin = image.transformed(
      by: CGAffineTransform(translationX: -extent.origin.x, y: -extent.origin.y)
    )
    if extent.size == size { return atOrigin }

    // Scale by the LARGER ratio so the crop covers the target, then trim the overhang
    // evenly. Scaling each axis independently — which this used to do — stretches a
    // 4:3 frame into a 9:16 file.
    let scale = max(size.width / extent.width, size.height / extent.height)
    let scaled = atOrigin.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let scaledExtent = scaled.extent
    let cropX = ((scaledExtent.width - size.width) / 2).rounded()
    let cropY = ((scaledExtent.height - size.height) / 2).rounded()
    return scaled
      .cropped(to: CGRect(x: cropX, y: cropY, width: size.width, height: size.height))
      .transformed(by: CGAffineTransform(translationX: -cropX, y: -cropY))
  }

  private static func fileURL(from path: String) -> URL {
    if path.hasPrefix("file://"), let url = URL(string: path) { return url }
    return URL(fileURLWithPath: path)
  }
}
