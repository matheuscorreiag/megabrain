// swift-tools-version:5.9
// The macOS app (Hub.app). Build and install with macos/build.sh.
import PackageDescription

let package = Package(
  name: "Hub",
  platforms: [.macOS(.v14)],
  targets: [.executableTarget(name: "Hub", path: "Sources/Hub")]
)
