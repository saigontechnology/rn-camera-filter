package com.saigontechnology.backgroundfilter.gl

import android.graphics.Bitmap
import android.opengl.GLES20
import android.opengl.GLUtils
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

/**
 * The composite shader program and its textures.
 *
 * Everything here is confined to the thread that created the EGL context — the
 * `CameraFrameOutput` thread for the live path. GL objects are not thread-safe
 * and there is no locking; the confinement IS the safety argument.
 *
 * The camera frame arrives as YUV_420_888 and is uploaded as two textures (Y, and
 * interleaved UV) which the shader converts to RGB. This is the portable path: it
 * needs no EGL extensions and works on every device.
 *
 * TODO(perf): a zero-copy path via `HardwareBuffer` + `EGL_ANDROID_image_native_buffer`
 * would avoid the per-frame CPU upload. Worth measuring before adopting, since it
 * raises the API floor and adds device-specific failure modes.
 */
class CompositeGl {

  private companion object {
    /** Full-screen quad, and its texture coordinates. */
    private val QUAD_COORDS = floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f)

    private const val VERTEX_SHADER = """
      attribute vec4 aPosition;
      uniform mat4 uTexTransform;
      varying vec2 vFrameUv;
      varying vec2 vMaskUv;
      varying vec2 vBackgroundUv;
      uniform vec4 uBackgroundRect;  // minU, minV, maxU, maxV
      uniform vec4 uFrameRect;       // minU, minV, maxU, maxV, in DISPLAY space
      void main() {
        gl_Position = aPosition;
        // Map clip space (-1..1) to texture space (0..1).
        vec2 uv = aPosition.xy * 0.5 + 0.5;
        // Camera buffers are top-down relative to GL's bottom-up convention.
        //
        // `uFrameRect` is the sub-rect of the camera's DISPLAYED image that fills
        // this viewport, which is what keeps the aspect ratio honest: sampling the
        // full 0..1 range instead would stretch a 9:16 frame across whatever aspect
        // the view happens to be. minU > maxU mirrors, since the mix() runs
        // backwards — that is how the front camera gets its expected mirroring.
        vec2 frameUv = vec2(
          mix(uFrameRect.x, uFrameRect.z, uv.x),
          mix(uFrameRect.y, uFrameRect.w, 1.0 - uv.y)
        );
        // The camera texture is in SENSOR space, so its lookup gets rotated.
        vFrameUv = (uTexTransform * vec4(frameUv, 0.0, 1.0)).xy;
        // The mask is NOT. MLKit is handed the frame's `rotationDegrees`, so the
        // mask it returns is already upright — in DISPLAY space, the same space
        // this quad is in. Rotating its lookup too would rotate the mask a second
        // time, which silhouettes the person against the wrong part of the frame.
        // It shares `uFrameRect`, so crop and mirror apply to mask and camera
        // identically and the silhouette cannot drift off the person.
        vMaskUv = frameUv;
        vBackgroundUv = vec2(
          mix(uBackgroundRect.x, uBackgroundRect.z, uv.x),
          mix(uBackgroundRect.y, uBackgroundRect.w, 1.0 - uv.y)
        );
      }
    """

    /**
     * YUV -> RGB using the BT.601 video-range matrix, then a mask lerp between the
     * background and the person.
     *
     * `uHasMask`/`uHasBackground` are uniforms rather than separate programs so a
     * frame that fails to segment still draws (the shader collapses to the raw
     * camera image) without a program switch mid-stream.
     */
    private const val FRAGMENT_SHADER = """
      precision mediump float;
      varying vec2 vFrameUv;
      varying vec2 vMaskUv;
      varying vec2 vBackgroundUv;
      uniform sampler2D uTextureY;
      uniform sampler2D uTextureUv;
      uniform sampler2D uTextureMask;
      uniform sampler2D uTextureBackground;
      uniform float uHasMask;
      uniform float uHasBackground;
      // Ratio of image width to TEXTURE width, per plane. Camera rows are padded to
      // a hardware stride, so a plane's texture is wider than its image and the
      // padding must never be sampled. 1.0 when the stride matches the width.
      uniform float uYScale;
      uniform float uUvScale;

      vec3 yuvToRgb(float y, vec2 uv) {
        float yy = 1.1643 * (y - 0.0625);
        float u = uv.x - 0.5;
        float v = uv.y - 0.5;
        return vec3(
          yy + 1.5958 * v,
          yy - 0.39173 * u - 0.81290 * v,
          yy + 2.017 * u
        );
      }

      void main() {
        // The stride scale is applied HERE, not in the vertex shader: the rotation in
        // `uTexTransform` has to happen in image space (it rotates about the image's
        // centre), and Y and UV can have different strides, so each sampler needs its
        // own factor at lookup time.
        float y = texture2D(uTextureY, vec2(vFrameUv.x * uYScale, vFrameUv.y)).r;
        vec2 uv = texture2D(uTextureUv, vec2(vFrameUv.x * uUvScale, vFrameUv.y)).ra;
        vec3 camera = clamp(yuvToRgb(y, uv), 0.0, 1.0);

        // Mask: 1.0 = person. Missing mask or background -> pass the frame through.
        // Sampled with vMaskUv (display space), not vFrameUv (sensor space).
        float person = mix(1.0, texture2D(uTextureMask, vMaskUv).r, uHasMask * uHasBackground);
        vec3 background = texture2D(uTextureBackground, vBackgroundUv).rgb;
        gl_FragColor = vec4(mix(background, camera, person), 1.0);
      }
    """

    private fun compile(type: Int, source: String): Int {
      val shader = GLES20.glCreateShader(type)
      // `glCreateShader` returning 0 means no EGL context is current on this
      // thread: every GL call is then a silent no-op that sets no error, and the
      // info log below comes back EMPTY. Say so explicitly — a bare "failed to
      // compile shader:" with nothing after it sent two separate debugging
      // sessions hunting for a GLSL bug that did not exist.
      if (shader == 0) {
        throw RuntimeException(
          "glCreateShader returned 0 — no EGL context is current on this thread. " +
            "Call EglCore.makeCurrent() on the thread that draws before setUp().",
        )
      }
      GLES20.glShaderSource(shader, source)
      GLES20.glCompileShader(shader)
      val status = IntArray(1)
      GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, status, 0)
      if (status[0] == 0) {
        val log = GLES20.glGetShaderInfoLog(shader)
        GLES20.glDeleteShader(shader)
        throw RuntimeException("Failed to compile shader: $log")
      }
      return shader
    }
  }

  private var program = 0
  private var positionHandle = 0
  private var texTransformHandle = 0
  private var backgroundRectHandle = 0
  private var frameRectHandle = 0
  private var textureYHandle = 0
  private var textureUvHandle = 0
  private var textureMaskHandle = 0
  private var textureBackgroundHandle = 0
  private var hasMaskHandle = 0
  private var hasBackgroundHandle = 0
  private var yScaleHandle = 0
  private var uvScaleHandle = 0

  /** Image-width / texture-width per plane; see the shader. Set by [uploadFrame]. */
  private var yScale = 1f
  private var uvScale = 1f

  private var textureY = 0
  private var textureUv = 0
  private var textureMask = 0
  private var textureBackground = 0

  private val quad: FloatBuffer =
    ByteBuffer.allocateDirect(QUAD_COORDS.size * 4)
      .order(ByteOrder.nativeOrder())
      .asFloatBuffer()
      .apply {
        put(QUAD_COORDS)
        position(0)
      }

  /** Rebuilt per frame from the frame's rotation; see [setRotation]. */
  private val texTransform = floatArrayOf(
    1f, 0f, 0f, 0f,
    0f, 1f, 0f, 0f,
    0f, 0f, 1f, 0f,
    0f, 0f, 0f, 1f,
  )

  /**
   * Rotates the camera texture lookup so the preview draws upright.
   *
   * Camera buffers arrive in SENSOR orientation — landscape on a portrait phone —
   * so sampling them 1:1 renders the preview rotated 90°. `rotationDegrees` is the
   * clockwise rotation needed to bring the image upright, which means the UV lookup
   * has to rotate the opposite way.
   *
   * The matrix rotates about the texture's centre (0.5, 0.5) and is column-major,
   * as GL expects. `vFrameUv` is top-down (y is flipped in the vertex shader), which
   * inverts the handedness — hence the negated angle.
   */
  private fun setRotation(rotationDegrees: Int) {
    val radians = -Math.toRadians(rotationDegrees.toDouble())
    val cos = Math.cos(radians).toFloat()
    val sin = Math.sin(radians).toFloat()

    texTransform[0] = cos
    texTransform[1] = sin
    texTransform[4] = -sin
    texTransform[5] = cos
    texTransform[12] = 0.5f - 0.5f * cos + 0.5f * sin
    texTransform[13] = 0.5f - 0.5f * sin - 0.5f * cos
  }

  var isBackgroundUploaded: Boolean = false
    private set

  /**
   * Whether the last [uploadFrame] carried a mask. Held here rather than passed to
   * [drawUploaded] so every target of the same frame agrees about it — a frame that
   * failed to segment must pass through on the preview and in the capture alike.
   */
  private var hasMask: Boolean = false

  fun setUp() {
    val vertex = compile(GLES20.GL_VERTEX_SHADER, VERTEX_SHADER)
    val fragment = compile(GLES20.GL_FRAGMENT_SHADER, FRAGMENT_SHADER)
    program = GLES20.glCreateProgram()
    GLES20.glAttachShader(program, vertex)
    GLES20.glAttachShader(program, fragment)
    GLES20.glLinkProgram(program)
    val status = IntArray(1)
    GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, status, 0)
    if (status[0] == 0) {
      val log = GLES20.glGetProgramInfoLog(program)
      throw RuntimeException("Failed to link program: $log")
    }
    // The program retains them after linking.
    GLES20.glDeleteShader(vertex)
    GLES20.glDeleteShader(fragment)

    positionHandle = GLES20.glGetAttribLocation(program, "aPosition")
    texTransformHandle = GLES20.glGetUniformLocation(program, "uTexTransform")
    backgroundRectHandle = GLES20.glGetUniformLocation(program, "uBackgroundRect")
    frameRectHandle = GLES20.glGetUniformLocation(program, "uFrameRect")
    textureYHandle = GLES20.glGetUniformLocation(program, "uTextureY")
    textureUvHandle = GLES20.glGetUniformLocation(program, "uTextureUv")
    textureMaskHandle = GLES20.glGetUniformLocation(program, "uTextureMask")
    textureBackgroundHandle = GLES20.glGetUniformLocation(program, "uTextureBackground")
    hasMaskHandle = GLES20.glGetUniformLocation(program, "uHasMask")
    hasBackgroundHandle = GLES20.glGetUniformLocation(program, "uHasBackground")
    yScaleHandle = GLES20.glGetUniformLocation(program, "uYScale")
    uvScaleHandle = GLES20.glGetUniformLocation(program, "uUvScale")

    textureY = createTexture()
    textureUv = createTexture()
    textureMask = createTexture()
    textureBackground = createTexture()
  }

  private fun createTexture(): Int {
    val ids = IntArray(1)
    GLES20.glGenTextures(1, ids, 0)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, ids[0])
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    // CLAMP_TO_EDGE matters: the default REPEAT would wrap a cropped background
    // and mirror-tile its edges.
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    return ids[0]
  }

  /** Uploads the background once. Must run on the GL thread. */
  fun uploadBackground(bitmap: Bitmap) {
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureBackground)
    GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0)
    isBackgroundUploaded = true
  }

  fun clearBackground() {
    isBackgroundUploaded = false
  }

  private fun uploadPlane(texture: Int, format: Int, width: Int, height: Int, data: ByteBuffer) {
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
    GLES20.glTexImage2D(
      GLES20.GL_TEXTURE_2D, 0, format, width, height, 0, format, GLES20.GL_UNSIGNED_BYTE, data,
    )
  }

  /**
   * Draws one composited frame.
   *
   * @param yPlane tightly packed Y plane, [frameWidth] x [frameHeight]
   * @param uvPlane interleaved UV, half dimensions
   * @param mask 8-bit person mask, or null to pass the frame through
   * @param backgroundUv normalized min/max UV of the background crop, from [BackgroundGeometry]
   * @param frameUv normalized min/max UV of the camera crop in DISPLAY space, from
   *   [BackgroundGeometry]; pass minU > maxU to mirror. Applied to the mask too.
   * @param rotationDegrees clockwise rotation needed to bring the frame upright
   */
  fun draw(
    yPlane: ByteBuffer,
    uvPlane: ByteBuffer,
    frameWidth: Int,
    frameHeight: Int,
    mask: ByteBuffer?,
    maskWidth: Int,
    maskHeight: Int,
    backgroundUv: FloatArray,
    frameUv: FloatArray,
    viewportWidth: Int,
    viewportHeight: Int,
    rotationDegrees: Int,
    yRowStride: Int = 0,
    uvRowStride: Int = 0,
  ) {
    uploadFrame(
      yPlane, uvPlane, frameWidth, frameHeight, mask, maskWidth, maskHeight,
      yRowStride, uvRowStride,
    )
    drawUploaded(backgroundUv, frameUv, viewportWidth, viewportHeight, rotationDegrees)
  }

  /**
   * Uploads one frame's textures without drawing.
   *
   * Split from [drawUploaded] so the same frame can be drawn to more than one
   * surface — the preview and the record-time capture's encoder — for the price of a
   * second draw call rather than a second CPU-side upload, which is the expensive
   * half (a 720p Y+UV pair is ~1.4 MB per pass).
   */
  fun uploadFrame(
    yPlane: ByteBuffer,
    uvPlane: ByteBuffer,
    frameWidth: Int,
    frameHeight: Int,
    mask: ByteBuffer?,
    maskWidth: Int,
    maskHeight: Int,
    /** `Image.Plane.rowStride` of the Y plane, in bytes. 0 = assume tightly packed. */
    yRowStride: Int = 0,
    /** `Image.Plane.rowStride` of the interleaved UV plane, in bytes. */
    uvRowStride: Int = 0,
  ) {
    // ─── Row stride ───
    //
    // `YUV_420_888` rows are padded to a hardware stride, and it is NOT always equal
    // to the width: a 960x720 buffer on a Galaxy S22 is tightly packed, a 1280x960 one
    // is not. Uploading `width` bytes per row from a padded buffer shifts every row by
    // the padding, shearing the image into vertical stripes — which is exactly what
    // raising the frame resolution produced.
    //
    // The whole stride is uploaded as texture width, so rows stay aligned, and the
    // shader samples only the image part of it (`uYScale`/`uUvScale`).
    val yStride = if (yRowStride > 0) yRowStride else frameWidth
    val uvStride = if (uvRowStride > 0) uvRowStride else frameWidth
    // LUMINANCE_ALPHA is 2 bytes per texel, and interleaved UV has 2 bytes per pixel,
    // so a row of `uvStride` bytes is `uvStride / 2` texels wide.
    val uvTexelStride = uvStride / 2

    // A plane's buffer can be a byte or two short of `stride * rows` (the last row's
    // padding is often omitted), and GL reads the full rectangle — so never ask for
    // more rows than the buffer actually holds.
    val yRows = minOf(frameHeight, yPlane.capacity() / yStride)
    val uvRows = minOf(frameHeight / 2, uvPlane.capacity() / uvStride)

    uploadPlane(textureY, GLES20.GL_LUMINANCE, yStride, yRows, yPlane)
    uploadPlane(textureUv, GLES20.GL_LUMINANCE_ALPHA, uvTexelStride, uvRows, uvPlane)

    yScale = frameWidth.toFloat() / yStride
    uvScale = (frameWidth / 2).toFloat() / uvTexelStride

    hasMask = mask != null
    if (mask != null) {
      // Ours, built in `segment()` — tightly packed by construction.
      uploadPlane(textureMask, GLES20.GL_LUMINANCE, maskWidth, maskHeight, mask)
    }
  }

  /**
   * Draws the frame uploaded by [uploadFrame] into the currently bound surface.
   *
   * Every argument here is per-*target*, not per-frame: a different viewport wants a
   * different crop, which is exactly how the capture writes the full frame while the
   * preview shows a cover-cropped one.
   */
  fun drawUploaded(
    backgroundUv: FloatArray,
    frameUv: FloatArray,
    viewportWidth: Int,
    viewportHeight: Int,
    rotationDegrees: Int,
  ) {
    setRotation(rotationDegrees)
    GLES20.glViewport(0, 0, viewportWidth, viewportHeight)
    GLES20.glClearColor(0f, 0f, 0f, 1f)
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
    GLES20.glUseProgram(program)

    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureY)
    GLES20.glUniform1i(textureYHandle, 0)

    GLES20.glActiveTexture(GLES20.GL_TEXTURE1)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureUv)
    GLES20.glUniform1i(textureUvHandle, 1)

    GLES20.glActiveTexture(GLES20.GL_TEXTURE2)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureMask)
    GLES20.glUniform1i(textureMaskHandle, 2)

    GLES20.glActiveTexture(GLES20.GL_TEXTURE3)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, textureBackground)
    GLES20.glUniform1i(textureBackgroundHandle, 3)

    GLES20.glUniformMatrix4fv(texTransformHandle, 1, false, texTransform, 0)
    GLES20.glUniform4fv(backgroundRectHandle, 1, backgroundUv, 0)
    GLES20.glUniform4fv(frameRectHandle, 1, frameUv, 0)
    GLES20.glUniform1f(yScaleHandle, yScale)
    GLES20.glUniform1f(uvScaleHandle, uvScale)
    GLES20.glUniform1f(hasMaskHandle, if (hasMask) 1f else 0f)
    GLES20.glUniform1f(hasBackgroundHandle, if (isBackgroundUploaded) 1f else 0f)

    GLES20.glEnableVertexAttribArray(positionHandle)
    GLES20.glVertexAttribPointer(positionHandle, 2, GLES20.GL_FLOAT, false, 0, quad)
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    GLES20.glDisableVertexAttribArray(positionHandle)
  }

  fun release() {
    if (program != 0) {
      GLES20.glDeleteProgram(program)
      program = 0
    }
    val textures = intArrayOf(textureY, textureUv, textureMask, textureBackground)
    GLES20.glDeleteTextures(textures.size, textures, 0)
    textureY = 0
    textureUv = 0
    textureMask = 0
    textureBackground = 0
    isBackgroundUploaded = false
  }
}
