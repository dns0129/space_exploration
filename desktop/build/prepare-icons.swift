// Re-render the existing website icon with macOS's native SVG support.
// Run from the repository root: swift desktop/build/prepare-icons.swift
import AppKit
import Foundation

let project = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = project.appendingPathComponent("public/favicon.svg")
let output = project.appendingPathComponent("desktop/build", isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
guard let image = NSImage(contentsOf: source) else {
    fatalError("Unable to load public/favicon.svg")
}
image.size = NSSize(width: 1024, height: 1024)

func render(_ size: Int) throws -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    return bitmap.representation(using: .png, properties: [:])!
}

try render(1024).write(to: output.appendingPathComponent("icon.png"))
let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
let iconset = temporary.appendingPathComponent("Voyager.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: temporary) }
for size in [16, 32, 128, 256, 512] {
    try render(size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try render(size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
let converter = Process()
converter.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
converter.arguments = ["-c", "icns", iconset.path, "-o", output.appendingPathComponent("icon.icns").path]
try converter.run()
converter.waitUntilExit()
guard converter.terminationStatus == 0 else { fatalError("iconutil failed") }

func append16(_ number: Int, to data: inout Data) {
    data.append(UInt8(number & 255))
    data.append(UInt8((number >> 8) & 255))
}
func append32(_ number: Int, to data: inout Data) {
    for shift in stride(from: 0, through: 24, by: 8) {
        data.append(UInt8((number >> shift) & 255))
    }
}
let sizes = [16, 24, 32, 48, 64, 128, 256]
let representations = try sizes.map { try render($0) }
var ico = Data()
append16(0, to: &ico)
append16(1, to: &ico)
append16(sizes.count, to: &ico)
var offset = 6 + 16 * sizes.count
for (size, bitmap) in zip(sizes, representations) {
    ico.append(size == 256 ? 0 : UInt8(size))
    ico.append(size == 256 ? 0 : UInt8(size))
    ico.append(contentsOf: [0, 0])
    append16(1, to: &ico)
    append16(32, to: &ico)
    append32(bitmap.count, to: &ico)
    append32(offset, to: &ico)
    offset += bitmap.count
}
for bitmap in representations { ico.append(bitmap) }
try ico.write(to: output.appendingPathComponent("icon.ico"))
print("Created desktop icons from public/favicon.svg.")
