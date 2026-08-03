//
//  HybridOfflineVideoProcessor.swift
//  VisionCameraBackgroundFilter
//

import AVFoundation
import CoreImage
import Foundation
import NitroModules

/**
 * Bakes a background into an already-recorded file (Scenario 10).
 *
 * `AVMutableVideoComposition(asset:applyingCIFiltersWithHandler:)` +
 * `AVAssetExportSession`. The composition only touches the video track, so
 * **AVFoundation copies the audio through and owns the muxing** — this package never
 * does A/V sync, which is where the hard device-specific bugs live.
 *
 * The blend runs through the same `BackgroundCompositor` and the same
 * `BackgroundGeometry` as the live preview, and loads the background through the same
 * `BackgroundImageLoader`. That shared path is what makes preview/output parity
 * structural on iOS rather than something to test our way into — the intended
 * difference is quality only: `.accurate` segmentation here versus `.balanced` live.
 */
final class HybridOfflineVideoProcessor: HybridOfflineVideoProcessorSpec {

  var isSupported: Bool {
    return SelfieSegmenter.isSupported
  }

  func start(options: OfflineJobOptions) throws -> any HybridOfflineVideoJobSpec {
    let job = HybridOfflineVideoJob()
    try job.start(options: options)
    return job
  }

  /**
   * Joins a video-only capture with the audio of the raw recording.
   *
   * `AVMutableComposition` + a **passthrough** export: neither track is decoded, so
   * this is a file copy rather than a transcode, and AVFoundation still owns the
   * muxing.
   *
   * Everything is loaded with the **async** `load(_:)` / `loadTracks(withMediaType:)`
   * API, not the synchronous `asset.tracks` / `asset.duration` accessors. Those are
   * deprecated for a reason: for a file another process has just finished writing they
   * can report **no tracks at all**, which is how a recording with sound shipped as a
   * silent clip — the audio lookup came back empty, the "a source with no audio is not
   * an error" path ran, and nothing anywhere said so.
   *
   * A source that really has no audio track now **throws**, for the same reason: the
   * caller passed an audio source because it expected audio. A consumer that wants a
   * silent clip calls `finish()` without an `audioSourcePath` instead.
   */
  func muxAudio(videoPath: String, audioSourcePath: String, outputPath: String) throws -> Promise<String> {
    let promise = Promise<String>()
    let videoURL = Self.fileURL(from: videoPath)
    let audioURL = Self.fileURL(from: audioSourcePath)
    let outputURL = Self.fileURL(from: outputPath)
    try? FileManager.default.removeItem(at: outputURL)

    Task {
      do {
        let videoAsset = AVURLAsset(url: videoURL)
        let (audioAsset, quickTimeAlias) = try await Self.readableAudioAsset(at: audioURL)
        defer { if let quickTimeAlias { try? FileManager.default.removeItem(at: quickTimeAlias) } }

        async let videoTracksTask = videoAsset.loadTracks(withMediaType: .video)
        async let audioTracksTask = audioAsset.loadTracks(withMediaType: .audio)
        async let videoDurationTask = videoAsset.load(.duration)
        async let audioDurationTask = audioAsset.load(.duration)

        let (videoTracks, audioTracks) = try await (videoTracksTask, audioTracksTask)
        let (videoDuration, audioDuration) = try await (videoDurationTask, audioDurationTask)

        guard let videoTrack = videoTracks.first else {
          throw RuntimeError.error(withMessage: "The captured file has no video track.")
        }
        guard let audioTrack = audioTracks.first else {
          throw RuntimeError.error(
            withMessage: "The audio source has no audio track: \(audioURL.lastPathComponent)."
          )
        }

        let composition = AVMutableComposition()
        guard
          let compositionVideo = composition.addMutableTrack(
            withMediaType: .video,
            preferredTrackID: kCMPersistentTrackID_Invalid
          ),
          let compositionAudio = composition.addMutableTrack(
            withMediaType: .audio,
            preferredTrackID: kCMPersistentTrackID_Invalid
          )
        else {
          throw RuntimeError.error(withMessage: "Could not build the output composition.")
        }

        try compositionVideo.insertTimeRange(
          CMTimeRange(start: .zero, duration: videoDuration),
          of: videoTrack,
          at: .zero
        )
        // The capture writes upright pixels, but carry the transform anyway: a source
        // that did rely on one would otherwise play back rotated.
        compositionVideo.preferredTransform = try await videoTrack.load(.preferredTransform)

        // ─── Alignment ───
        //
        // The recording starts BEFORE the capture (the consumer waits for the recorder
        // to actually start, then begins encoding) and stops with it, so the audio is
        // longer and the excess is at the HEAD: sound captured before the first
        // composited frame existed. Taking the audio from zero is what makes it run
        // ahead of the picture — measured at 370 ms on Android's first device run.
        //
        // The gap between the two durations IS that head offset, so it is skipped
        // rather than guessed at. Valid only while the capture is contained within the
        // recording, which `startCompositeCapture` documents; if that contract is
        // broken this clamps to zero, i.e. no correction.
        let headOffset = CMTimeMaximum(CMTimeSubtract(audioDuration, videoDuration), .zero)
        let usableAudio = CMTimeMinimum(CMTimeSubtract(audioDuration, headOffset), videoDuration)
        guard usableAudio.isValid, usableAudio.seconds > 0 else {
          throw RuntimeError.error(
            withMessage: "The audio source reported no usable duration (\(audioDuration.seconds)s)."
          )
        }
        try compositionAudio.insertTimeRange(
          CMTimeRange(start: headOffset, duration: usableAudio),
          of: audioTrack,
          at: .zero
        )

        guard
          let export = AVAssetExportSession(
            asset: composition,
            presetName: AVAssetExportPresetPassthrough
          )
        else {
          throw RuntimeError.error(withMessage: "Could not create an export session.")
        }
        export.outputURL = outputURL
        export.outputFileType = .mp4
        export.shouldOptimizeForNetworkUse = true

        await export.export()
        if export.status == .completed {
          promise.resolve(withResult: outputURL.path)
        } else {
          try? FileManager.default.removeItem(at: outputURL)
          let message = export.error?.localizedDescription ?? "The remux failed."
          promise.reject(withError: RuntimeError.error(withMessage: message))
        }
      } catch {
        try? FileManager.default.removeItem(at: outputURL)
        promise.reject(withError: error)
      }
    }

    return promise
  }

  /**
   * Opens the audio source, working around a container/extension mismatch.
   *
   * `AVURLAsset` chooses its parser from the URL's **extension**, not the file's
   * contents. `AVCaptureMovieFileOutput` — what VisionCamera records with — always
   * writes a QuickTime container, so asking it for `'mp4'` yields a QuickTime file
   * named `.mp4`. AVFoundation's MP4 parser then reads the video track and silently
   * **drops the QuickTime-style audio sample entry**: zero audio tracks, no error.
   * Verified on a real recording — opened as `.mp4` it reports 0 audio tracks, the
   * same bytes renamed `.mov` report 1.
   *
   * The consumer's real fix is to record as `'mov'` so the name matches the container.
   * This is the safety net for when it does not: if the source reports no audio and is
   * not already `.mov`, retry through a symlink that is. A symlink costs nothing —
   * copying a 30 MB recording just to rename it would not.
   *
   * Returns the asset and, when one was created, the alias to clean up.
   */
  private static func readableAudioAsset(at url: URL) async throws -> (AVURLAsset, URL?) {
    let asset = AVURLAsset(url: url)
    let tracks = try await asset.loadTracks(withMediaType: .audio)
    if !tracks.isEmpty || url.pathExtension.lowercased() == "mov" {
      return (asset, nil)
    }

    let alias = FileManager.default.temporaryDirectory
      .appendingPathComponent("bgfilter-audio-\(UUID().uuidString)")
      .appendingPathExtension("mov")
    do {
      try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: url)
    } catch {
      return (asset, nil)
    }

    let retried = AVURLAsset(url: alias)
    if (try? await retried.loadTracks(withMediaType: .audio))?.isEmpty == false {
      return (retried, alias)
    }
    try? FileManager.default.removeItem(at: alias)
    return (asset, nil)
  }
  private static func fileURL(from path: String) -> URL {
    if path.hasPrefix("file://"), let url = URL(string: path) { return url }
    return URL(fileURLWithPath: path)
  }
}

/**
 * One running bake.
 *
 * Owns the export session so it can report progress and cancel. `result()` hands back
 * a promise that resolves when the output file is fully written and muxed.
 */
final class HybridOfflineVideoJob: HybridOfflineVideoJobSpec {

  private enum Failure: Error {
    case noVideoTrack
    case unsupported
    case exportFailed(String)
    case cancelled
  }

  /// Progress is reported to JS at ~10/s, matching the documented contract.
  private static let progressInterval: TimeInterval = 0.1

  private var exportSession: AVAssetExportSession?
  private var progressTimer: Timer?
  private var onProgress: ((Double) -> Void)?
  private let promise = Promise<OfflineJobResult>()
  private var isCancelled = false

  // Held for the lifetime of the export: the CoreImage handler runs per frame and
  // must not rebuild either of these.
  private let segmenter = SelfieSegmenter(quality: .accurate)
  private let compositor = BackgroundCompositor()
  private let ciContext = CIContext(options: [.workingColorSpace: NSNull()])

  func setOnProgress(onProgress: ((_ progress: Double) -> Void)?) throws {
    self.onProgress = onProgress
  }

  func result() throws -> Promise<OfflineJobResult> {
    return promise
  }

  func cancel() throws {
    isCancelled = true
    exportSession?.cancelExport()
  }

  func start(options: OfflineJobOptions) throws {
    guard SelfieSegmenter.isSupported else { throw Failure.unsupported }

    let inputURL = Self.fileURL(from: options.inputPath)
    let outputURL = Self.fileURL(from: options.outputPath)
    // AVAssetExportSession refuses to overwrite an existing file.
    try? FileManager.default.removeItem(at: outputURL)

    let asset = AVURLAsset(url: inputURL)
    guard let track = asset.tracks(withMediaType: .video).first else {
      throw Failure.noVideoTrack
    }

    let background = BackgroundImageLoader.load(uri: options.background.uri)
    compositor.setBackground(
      background,
      fit: options.background.fit == .cover ? .cover : .contain,
      mirror: options.background.mirror
    )

    // The recorded track stores landscape pixels plus a `preferredTransform` that
    // rotates them for display. `applyingCIFiltersWithHandler` hands the handler the
    // RAW pixels with that transform NOT applied, so a portrait clip arrives
    // sideways. Rotating inside the handler and setting `renderSize` to the display
    // size produces an upright output with an identity transform — the alternative
    // (leaving the transform on the output) would rotate twice on playback.
    let transform = track.preferredTransform
    let naturalSize = track.naturalSize
    let displaySize = naturalSize.applying(transform)
    let renderSize = CGSize(width: abs(displaySize.width), height: abs(displaySize.height))

    let composition = AVMutableVideoComposition(
      asset: asset,
      applyingCIFiltersWithHandler: { [weak self] request in
        guard let self else {
          request.finish(with: Failure.cancelled)
          return
        }
        let output = self.composite(request.sourceImage, transform: transform, renderSize: renderSize)
        request.finish(with: output, context: self.ciContext)
      }
    )
    composition.renderSize = renderSize

    guard
      let export = AVAssetExportSession(
        asset: asset,
        presetName: Self.preset(maxOutputHeight: options.maxOutputHeight, renderSize: renderSize)
      )
    else {
      throw Failure.exportFailed("Could not create an export session.")
    }
    export.videoComposition = composition
    export.outputURL = outputURL
    export.outputFileType = .mp4
    // The moov atom at the head lets playback start without fetching the tail —
    // the same reason the app's compress step passes `-movflags +faststart`.
    export.shouldOptimizeForNetworkUse = true
    exportSession = export

    let startedAt = Date()
    startProgressReporting()

    export.exportAsynchronously { [weak self] in
      guard let self else { return }
      self.stopProgressReporting()

      switch export.status {
      case .completed:
        // Report 1.0 exactly once, so a consumer's progress UI lands on 100%.
        self.onProgress?(1)
        self.promise.resolve(
          withResult: OfflineJobResult(
            outputPath: outputURL.path,
            durationMs: Date().timeIntervalSince(startedAt) * 1000
          )
        )
      case .cancelled:
        // `cancelExport()` leaves whatever it had already written at `outputURL`.
        // Nothing downstream knows that path (the caller only learns it on
        // success), so if we do not remove it here the partial file leaks for the
        // lifetime of the app. Matches Android, which deletes on cancel too.
        try? FileManager.default.removeItem(at: outputURL)
        self.promise.reject(withError: Failure.cancelled)
      default:
        try? FileManager.default.removeItem(at: outputURL)
        let message = export.error?.localizedDescription ?? "The export failed."
        self.promise.reject(withError: Failure.exportFailed(message))
      }
    }
  }

  /// Segments and composites one frame, in the display-upright coordinate space.
  private func composite(_ sourceImage: CIImage, transform: CGAffineTransform, renderSize: CGSize) -> CIImage {
    // Bring the raw track pixels upright, then translate the (possibly negative)
    // extent back to the origin so it matches `renderSize`.
    var upright = sourceImage.transformed(by: transform)
    upright = upright.transformed(
      by: CGAffineTransform(translationX: -upright.extent.origin.x, y: -upright.extent.origin.y)
    )

    guard compositor.hasBackground else { return upright }

    // Vision needs a pixel buffer, so the oriented frame is rendered into one first.
    // `.up` is correct here precisely because `upright` is already display-oriented.
    guard let buffer = renderToPixelBuffer(upright, size: renderSize),
          let mask = segmenter.segment(pixelBuffer: buffer, orientation: .up)
    else {
      // A frame that fails to segment is written unmodified rather than dropped or
      // reused from the previous mask — a stale mask would smear the silhouette
      // across the clip.
      return upright
    }

    return compositor.composite(frame: upright, mask: mask)
  }

  private func renderToPixelBuffer(_ image: CIImage, size: CGSize) -> CVPixelBuffer? {
    var buffer: CVPixelBuffer?
    let attributes: [String: Any] = [
      kCVPixelBufferCGImageCompatibilityKey as String: true,
      kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
    ]
    let status = CVPixelBufferCreate(
      kCFAllocatorDefault,
      Int(size.width),
      Int(size.height),
      kCVPixelFormatType_32BGRA,
      attributes as CFDictionary,
      &buffer
    )
    guard status == kCVReturnSuccess, let buffer else { return nil }
    ciContext.render(image, to: buffer)
    return buffer
  }

  /**
   * Picks an export preset.
   *
   * `maxOutputHeight` exists to bound bake time on slow devices; AVFoundation only
   * offers fixed presets, so this maps the cap onto the nearest one rather than
   * inventing an arbitrary bitrate. 0 means "keep the source resolution".
   */
  private static func preset(maxOutputHeight: Double, renderSize: CGSize) -> String {
    let cap = maxOutputHeight > 0 ? maxOutputHeight : Double(max(renderSize.width, renderSize.height))
    if cap <= 640 { return AVAssetExportPreset640x480 }
    if cap <= 960 { return AVAssetExportPreset960x540 }
    if cap <= 1280 { return AVAssetExportPreset1280x720 }
    if cap <= 1920 { return AVAssetExportPreset1920x1080 }
    return AVAssetExportPresetHighestQuality
  }

  private static func fileURL(from path: String) -> URL {
    if path.hasPrefix("file://"), let url = URL(string: path) { return url }
    return URL(fileURLWithPath: path)
  }

  private func startProgressReporting() {
    // `AVAssetExportSession` exposes progress as a poll-only property, so this is a
    // timer rather than a callback. Main run loop: the block only reads a float and
    // forwards it.
    progressTimer = Timer.scheduledTimer(withTimeInterval: Self.progressInterval, repeats: true) {
      [weak self] _ in
      guard let self, let export = self.exportSession else { return }
      self.onProgress?(Double(export.progress))
    }
  }

  private func stopProgressReporting() {
    progressTimer?.invalidate()
    progressTimer = nil
  }

  // `deinit`, not an override of `dispose()`: on iOS the generated spec is a
  // protocol plus a base class that has no `dispose()` to override (unlike the
  // Kotlin spec, which is a class that does).
  deinit {
    stopProgressReporting()
    if !isCancelled { exportSession?.cancelExport() }
  }
}
