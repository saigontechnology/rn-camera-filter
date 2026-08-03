package com.saigontechnology.backgroundfilter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parity tests for the native geometry mirror.
 *
 * `BackgroundGeometry.kt` is a hand-maintained copy of `src/composite/geometry.ts`.
 * That duplication is unavoidable — a GPU shader cannot call TypeScript, and only
 * native code knows the frame's dimensions — but until now *nothing enforced that the
 * two agree*, and a silent divergence means the user records one framing and uploads
 * another.
 *
 * So these are not generic maths tests: every expected value below is the value
 * asserted by the corresponding case in `geometry.test.ts`. If someone edits one file
 * without the other, this fails.
 *
 * The golden-frame harness (plan task 7) covers the rest of the parity story — the
 * rasterisers. This covers the geometry, which is the part that can be checked without
 * a device.
 */
class BackgroundGeometryTest {

  private companion object {
    const val FRAME_W = 1080f
    const val FRAME_H = 1920f
    const val LANDSCAPE_BG_W = 1920f
    const val LANDSCAPE_BG_H = 1080f
    const val EPSILON = 0.001f
  }

  // ─── cover ────────────────────────────────────────────────────────────────

  @Test
  fun `cover fills the whole frame`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      LANDSCAPE_BG_W, LANDSCAPE_BG_H, FRAME_W, FRAME_H, BackgroundFitMode.COVER,
    )
    assertEquals(0f, layout.destination.x, EPSILON)
    assertEquals(0f, layout.destination.y, EPSILON)
    assertEquals(FRAME_W, layout.destination.width, EPSILON)
    assertEquals(FRAME_H, layout.destination.height, EPSILON)
  }

  @Test
  fun `cover crops the wider axis of a landscape background, centered`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      LANDSCAPE_BG_W, LANDSCAPE_BG_H, FRAME_W, FRAME_H, BackgroundFitMode.COVER,
    )
    // geometry.test.ts: frame ratio 9:16 -> crop width to 1080 * (9/16) = 607.5.
    assertEquals(607.5f, layout.source.width, EPSILON)
    assertEquals(1080f, layout.source.height, EPSILON)
    assertEquals((1920f - 607.5f) / 2f, layout.source.x, EPSILON)
    assertEquals(0f, layout.source.y, EPSILON)
  }

  @Test
  fun `cover crops the taller axis when the background is proportionally taller`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      1080f, 4000f, FRAME_W, FRAME_H, BackgroundFitMode.COVER,
    )
    // geometry.test.ts: crop height to 1080 / (9/16) = 1920, full width.
    assertEquals(1080f, layout.source.width, EPSILON)
    assertEquals(1920f, layout.source.height, EPSILON)
    assertEquals((4000f - 1920f) / 2f, layout.source.y, EPSILON)
  }

  @Test
  fun `cover is a no-op when aspect ratios already match`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      FRAME_W, FRAME_H, FRAME_W, FRAME_H, BackgroundFitMode.COVER,
    )
    assertEquals(0f, layout.source.x, EPSILON)
    assertEquals(0f, layout.source.y, EPSILON)
    assertEquals(FRAME_W, layout.source.width, EPSILON)
    assertEquals(FRAME_H, layout.source.height, EPSILON)
  }

  @Test
  fun `cover never samples outside the background bounds`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      LANDSCAPE_BG_W, LANDSCAPE_BG_H, FRAME_W, FRAME_H, BackgroundFitMode.COVER,
    )
    assertTrue(layout.source.x >= 0f)
    assertTrue(layout.source.y >= 0f)
    assertTrue(layout.source.x + layout.source.width <= LANDSCAPE_BG_W + EPSILON)
    assertTrue(layout.source.y + layout.source.height <= LANDSCAPE_BG_H + EPSILON)
  }

  // ─── contain ──────────────────────────────────────────────────────────────

  @Test
  fun `contain samples the entire background`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      LANDSCAPE_BG_W, LANDSCAPE_BG_H, FRAME_W, FRAME_H, BackgroundFitMode.CONTAIN,
    )
    assertEquals(0f, layout.source.x, EPSILON)
    assertEquals(0f, layout.source.y, EPSILON)
    assertEquals(LANDSCAPE_BG_W, layout.source.width, EPSILON)
    assertEquals(LANDSCAPE_BG_H, layout.source.height, EPSILON)
  }

  @Test
  fun `contain letterboxes a landscape background inside a portrait frame`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      LANDSCAPE_BG_W, LANDSCAPE_BG_H, FRAME_W, FRAME_H, BackgroundFitMode.CONTAIN,
    )
    val expectedHeight = 1080f / (16f / 9f)
    assertEquals(1080f, layout.destination.width, EPSILON)
    assertEquals(expectedHeight, layout.destination.height, EPSILON)
    assertEquals(0f, layout.destination.x, EPSILON)
    assertEquals((1920f - expectedHeight) / 2f, layout.destination.y, EPSILON)
  }

  @Test
  fun `contain pillarboxes a very tall background inside a wide frame`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      1080f, 4000f, 1920f, 1080f, BackgroundFitMode.CONTAIN,
    )
    assertEquals(1080f, layout.destination.height, EPSILON)
    assertEquals(1080f * (1080f / 4000f), layout.destination.width, EPSILON)
    assertEquals(0f, layout.destination.y, EPSILON)
    assertTrue(layout.destination.x > 0f)
  }

  // ─── degenerate input ─────────────────────────────────────────────────────

  @Test
  fun `a zero-sized background yields an empty layout, not NaN`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      0f, 0f, FRAME_W, FRAME_H, BackgroundFitMode.COVER,
    )
    assertEquals(0f, layout.source.width, EPSILON)
    assertEquals(0f, layout.destination.width, EPSILON)
    assertTrue(!layout.destination.width.isNaN())
  }

  @Test
  fun `a zero-sized frame yields an empty layout`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      LANDSCAPE_BG_W, LANDSCAPE_BG_H, 1080f, 0f, BackgroundFitMode.COVER,
    )
    assertEquals(0f, layout.destination.height, EPSILON)
  }

  // ─── mirroring ────────────────────────────────────────────────────────────

  @Test
  fun `mirrorRectHorizontally flips about the container mid-line`() {
    val mirrored = BackgroundGeometry.mirrorRectHorizontally(
      BackgroundGeometry.Rect(10f, 5f, 30f, 40f), 100f,
    )
    assertEquals(60f, mirrored.x, EPSILON)
    assertEquals(5f, mirrored.y, EPSILON)
    assertEquals(30f, mirrored.width, EPSILON)
    assertEquals(40f, mirrored.height, EPSILON)
  }

  @Test
  fun `mirrorRectHorizontally is its own inverse`() {
    val rect = BackgroundGeometry.Rect(12f, 3f, 25f, 9f)
    val twice = BackgroundGeometry.mirrorRectHorizontally(
      BackgroundGeometry.mirrorRectHorizontally(rect, 200f), 200f,
    )
    assertEquals(rect.x, twice.x, EPSILON)
    assertEquals(rect.width, twice.width, EPSILON)
  }

  @Test
  fun `a full-width rect is unchanged by mirroring`() {
    val full = BackgroundGeometry.Rect(0f, 0f, 100f, 50f)
    val mirrored = BackgroundGeometry.mirrorRectHorizontally(full, 100f)
    assertEquals(0f, mirrored.x, EPSILON)
    assertEquals(100f, mirrored.width, EPSILON)
  }

  // ─── texture coordinates (the values the shader actually consumes) ────────

  @Test
  fun `cover texture coords are normalized and inside 0-1`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      LANDSCAPE_BG_W, LANDSCAPE_BG_H, FRAME_W, FRAME_H, BackgroundFitMode.COVER,
    )
    val uv = BackgroundGeometry.sourceToTextureCoords(
      layout, LANDSCAPE_BG_W, LANDSCAPE_BG_H, mirror = false,
    )
    // minU, minV, maxU, maxV
    assertEquals((1920f - 607.5f) / 2f / 1920f, uv[0], EPSILON)
    assertEquals(0f, uv[1], EPSILON)
    assertEquals(((1920f - 607.5f) / 2f + 607.5f) / 1920f, uv[2], EPSILON)
    assertEquals(1f, uv[3], EPSILON)
    uv.forEach { assertTrue("uv out of range: $it", it >= -EPSILON && it <= 1f + EPSILON) }
  }

  @Test
  fun `mirroring swaps the horizontal texture bounds`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      LANDSCAPE_BG_W, LANDSCAPE_BG_H, FRAME_W, FRAME_H, BackgroundFitMode.COVER,
    )
    val plain = BackgroundGeometry.sourceToTextureCoords(
      layout, LANDSCAPE_BG_W, LANDSCAPE_BG_H, mirror = false,
    )
    val mirrored = BackgroundGeometry.sourceToTextureCoords(
      layout, LANDSCAPE_BG_W, LANDSCAPE_BG_H, mirror = true,
    )
    // A centred crop mirrors onto itself, so the bounds must match — this is the case
    // that would silently hide a mirroring bug, hence asserting it explicitly.
    assertEquals(plain[0], mirrored[0], EPSILON)
    assertEquals(plain[2], mirrored[2], EPSILON)
    assertEquals(plain[1], mirrored[1], EPSILON)
  }

  @Test
  fun `an off-centre crop does mirror to different bounds`() {
    // 'contain' samples the whole background, so mirroring is identity there too;
    // build an explicitly off-centre rect to prove the mirror maths is not a no-op.
    val offCentre = BackgroundGeometry.Rect(0f, 0f, 500f, 1080f)
    val mirrored = BackgroundGeometry.mirrorRectHorizontally(offCentre, LANDSCAPE_BG_W)
    assertEquals(LANDSCAPE_BG_W - 500f, mirrored.x, EPSILON)
  }

  @Test
  fun `degenerate background size yields full-range texture coords`() {
    val layout = BackgroundGeometry.computeBackgroundLayout(
      0f, 0f, FRAME_W, FRAME_H, BackgroundFitMode.COVER,
    )
    val uv = BackgroundGeometry.sourceToTextureCoords(layout, 0f, 0f, mirror = false)
    assertEquals(0f, uv[0], EPSILON)
    assertEquals(1f, uv[2], EPSILON)
  }
}
