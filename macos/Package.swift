// swift-tools-version:5.9
// The macOS app (Megabrain.app). Build and install with macos/build.sh.
import PackageDescription

let package = Package(
  name: "Megabrain",
  platforms: [.macOS(.v14)],
  targets: [.executableTarget(name: "Megabrain", path: "Sources/Megabrain")]
)
