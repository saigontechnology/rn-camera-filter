//
//  HybridBackgroundRendererView.swift
//  VisionCameraBackgroundFilter
//

import Foundation
import NitroModules
import UIKit

/// A `UIView` backed by a `CAMetalLayer`, which is what the renderer presents into.
final class MetalPreviewView: UIView {
  override class var layerClass: AnyClass {
    return CAMetalLayer.self
  }

  var metalLayer: CAMetalLayer {
    // Safe by construction: `layerClass` above guarantees the type.
    return layer as! CAMetalLayer
  }
}

/**
 * Hosts the layer the composited frames are drawn into.
 *
 * The renderer may be assigned before the view is laid out (the camera session
 * starts without waiting on layout), so the connection is (re)made both when
 * `renderer` is set and when the layer's size is known.
 */
final class HybridBackgroundRendererView: HybridBackgroundRendererViewSpec {

  private let previewView = MetalPreviewView()

  var view: MetalPreviewView {
    return previewView
  }

  var renderer: (any HybridBackgroundRendererSpec)? {
    didSet {
      (oldValue as? NativeSurfaceRenderer)?.disconnectLayer()
      connect()
    }
  }

  private func connect() {
    guard let nativeRenderer = renderer as? NativeSurfaceRenderer else { return }
    nativeRenderer.connectLayer(previewView.metalLayer)
  }

  override init() {
    super.init()
    // The layer's contentsScale has to track the screen, or the preview renders at
    // 1x on a 3x display and looks soft.
    previewView.metalLayer.contentsScale = UIScreen.main.scale
  }

  deinit {
    (renderer as? NativeSurfaceRenderer)?.disconnectLayer()
  }
}
