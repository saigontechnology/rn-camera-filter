require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "VisionCameraBackgroundFilter"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/saigontechnology/vision-camera-background-filter"
  s.license      = package["license"]
  s.authors      = "Saigon Technology"

  # Vision's person-segmentation request is iOS 15+; the pod itself still builds
  # for the app's deployment target and gates at runtime (see SelfieSegmenter).
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/saigontechnology/vision-camera-background-filter.git", :tag => "#{s.version}" }

  s.source_files = [
    # Implementation (Swift)
    "ios/**/*.{swift}",
    # Autolinking/Registration (Objective-C++)
    "ios/**/*.{m,mm}",
  ]

  s.frameworks = ["AVFoundation", "CoreImage", "CoreVideo", "Metal", "QuartzCore", "Vision"]

  # Adds the nitrogen-generated Swift/C++ bindings to this pod.
  load 'nitrogen/generated/ios/VisionCameraBackgroundFilter+autolinking.rb'
  add_nitrogen_files(s)

  # VisionCamera provides `HybridFrameSpec` (the generated renderFrame parameter)
  # and the public `NativeFrame` protocol the renderer casts to in order to reach a
  # frame's CMSampleBuffer.
  s.dependency "VisionCamera"
  s.dependency "NitroModules"
  s.dependency "React-jsi"
  s.dependency "React-callinvoker"

  install_modules_dependencies(s)
end
