// swift-tools-version:5.9
// The macOS app (Mothership.app). Build and install with macos/build.sh.
import PackageDescription

let package = Package(
  name: "Mothership",
  platforms: [.macOS(.v14)],
  targets: [.executableTarget(name: "Mothership", path: "Sources/Mothership")]
)
