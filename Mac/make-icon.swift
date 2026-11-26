// Breakpad: draws the app icon (dark tile, 4x4 pads, three lit) into an .iconset folder.
import AppKit

let out = CommandLine.arguments[1]
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

func draw(_ px: Int) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let g = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    NSGraphicsContext.current = g
    let ctx = g.cgContext
    let s = CGFloat(px) / 1024
    ctx.scaleBy(x: s, y: s)
    let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
    let path = CGPath(roundedRect: tile, cornerWidth: 186, cornerHeight: 186, transform: nil)
    ctx.addPath(path)
    ctx.setFillColor(CGColor(srgbRed: 0.055, green: 0.055, blue: 0.06, alpha: 1))
    ctx.fillPath()
    let lit: Set<Int> = [5, 11, 12]
    let cell: CGFloat = 138
    let gap: CGFloat = 34
    let start: CGFloat = 512 - (cell * 4 + gap * 3) / 2
    for row in 0..<4 {
        for col in 0..<4 {
            let r = CGRect(x: start + CGFloat(col) * (cell + gap), y: start + CGFloat(row) * (cell + gap), width: cell, height: cell)
            let on = lit.contains(row * 4 + col)
            ctx.setFillColor(on ? CGColor(srgbRed: 0.243, green: 0.902, blue: 0.69, alpha: 1) : CGColor(srgbRed: 0.15, green: 0.15, blue: 0.165, alpha: 1))
            ctx.addPath(CGPath(roundedRect: r, cornerWidth: 34, cornerHeight: 34, transform: nil))
            ctx.fillPath()
        }
    }
    ctx.addPath(path)
    ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.08))
    ctx.setLineWidth(3)
    ctx.strokePath()
    g.flushGraphics()
    return rep.representation(using: .png, properties: [:])
}

for (name, px) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
    try? draw(px)?.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
}
