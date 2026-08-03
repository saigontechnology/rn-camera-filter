package com.margelo.nitro.backgroundfilter

import com.margelo.nitro.core.Promise
import com.saigontechnology.backgroundfilter.BackgroundFitMode
import com.saigontechnology.backgroundfilter.OfflineVideoProcessor
import com.saigontechnology.backgroundfilter.SelfieSegmenter
import com.saigontechnology.backgroundfilter.capture.AudioMuxer
import java.util.concurrent.Executors

/**
 * Nitro entry point for the Android offline bake (plan task 6).
 *
 * The pipeline itself lives in [OfflineVideoProcessor]; this class only owns the
 * threading and the promise. See that file for why the audio is copied rather than
 * decoded, and why the decoder emits YUV images instead of feeding a SurfaceTexture.
 */
class HybridOfflineVideoProcessor : HybridOfflineVideoProcessorSpec() {

  override val isSupported: Boolean
    get() = SelfieSegmenter.isSupported

  override fun start(options: OfflineJobOptions): HybridOfflineVideoJobSpec {
    val job = HybridOfflineVideoJob(options)
    job.start()
    return job
  }

  /**
   * Joins a record-time capture with the audio of the raw recording — see
   * [AudioMuxer] for why neither track is decoded.
   *
   * Runs on a throwaway daemon thread: it is a one-shot file copy, over in well under
   * a second for a 30 s clip, and `MediaExtractor`/`MediaMuxer` both block.
   */
  override fun muxAudio(
    videoPath: String,
    audioSourcePath: String,
    outputPath: String,
  ): Promise<String> {
    val promise = Promise<String>()
    Thread({
      try {
        promise.resolve(AudioMuxer.mux(videoPath, audioSourcePath, outputPath))
      } catch (e: Throwable) {
        promise.reject(e)
      }
    }, "background-filter-mux").apply { isDaemon = true }.start()
    return promise
  }
}

/**
 * One running bake.
 *
 * Runs on a single-thread executor: MediaCodec's synchronous mode blocks, so this
 * must never touch the main thread. The executor is shut down in [dispose] so a
 * screen that unmounts mid-bake does not leak it.
 */
class HybridOfflineVideoJob(private val options: OfflineJobOptions) :
  HybridOfflineVideoJobSpec() {

  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "background-filter-bake").apply { isDaemon = true }
  }

  private val promise = Promise<OfflineJobResult>()
  private var onProgress: ((Double) -> Unit)? = null

  private val processor = OfflineVideoProcessor(
    inputPath = options.inputPath,
    outputPath = options.outputPath,
    backgroundUri = options.background.uri,
    fit = when (options.background.fit) {
      BackgroundFit.COVER -> BackgroundFitMode.COVER
      BackgroundFit.CONTAIN -> BackgroundFitMode.CONTAIN
    },
    mirror = options.background.mirror,
    maxOutputHeight = options.maxOutputHeight.toInt(),
  )

  fun start() {
    processor.onProgress = { progress -> onProgress?.invoke(progress) }
    executor.execute {
      val startedAt = System.nanoTime()
      try {
        val output = processor.run()
        val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000.0
        promise.resolve(OfflineJobResult(outputPath = output, durationMs = elapsedMs))
      } catch (e: Throwable) {
        promise.reject(e)
      }
    }
  }

  override fun setOnProgress(onProgress: ((progress: Double) -> Unit)?) {
    this.onProgress = onProgress
  }

  override fun result(): Promise<OfflineJobResult> = promise

  override fun cancel() {
    processor.cancel()
  }

  override fun dispose() {
    super.dispose()
    processor.cancel()
    executor.shutdownNow()
  }
}
