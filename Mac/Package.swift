// swift-tools-version: 6.2
// Breakpad for Mac: native shell around the web app that turns the trackpad and Touch Bar into pads.
import PackageDescription

let package = Package(
    name: "Breakpad",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Breakpad", path: "Sources/Breakpad")
    ],
    swiftLanguageModes: [.v5]
)
