// Breakpad for Mac: reads raw trackpad touches and maps each finger landing on an 8x4 grid to a pad hit.
import AppKit

final class TrackpadView: NSView {
    weak var app: AppDelegate?
    var captured = false
    private var live: [AnyHashable: (bank: Int, index: Int, id: String)] = [:]
    private var counter = 0
    private weak var fed: NSEvent?
    private var lastDots = 0.0

    override init(frame: NSRect) {
        super.init(frame: frame)
        allowedTouchTypes = [.indirect]
        wantsRestingTouches = true
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { captured ? self : nil }
    override var acceptsFirstResponder: Bool { false }
    override func mouseDown(with event: NSEvent) {}
    override func mouseDragged(with event: NSEvent) {}
    override func mouseUp(with event: NSEvent) {}
    override func rightMouseDown(with event: NSEvent) {}
    override func scrollWheel(with event: NSEvent) {}
    override func magnify(with event: NSEvent) {}
    override func rotate(with event: NSEvent) {}
    override func swipe(with event: NSEvent) {}
    override func smartMagnify(with event: NSEvent) {}

    override func touchesBegan(with event: NSEvent) { feed(event) }
    override func touchesMoved(with event: NSEvent) { feed(event) }
    override func touchesEnded(with event: NSEvent) { feed(event) }
    override func touchesCancelled(with event: NSEvent) { feed(event) }

    private func key(_ t: NSTouch) -> AnyHashable { AnyHashable(t.identity as! NSObject) }

    static func pad(_ p: NSPoint) -> (Int, Int) {
        let col = min(7, max(0, Int(p.x * 8)))
        let row = min(3, max(0, Int(p.y * 4)))
        return (col < 4 ? 0 : 1, row * 4 + col % 4)
    }

    func feed(_ event: NSEvent) {
        guard event.type == .gesture, event !== fed, let app else { return }
        fed = event
        let touches = event.allTouches().filter { $0.type == .indirect }
        if touches.isEmpty { return }
        if captured {
            for t in touches where t.phase == .began {
                let k = key(t)
                if live[k] != nil { continue }
                let (bank, index) = TrackpadView.pad(t.normalizedPosition)
                counter += 1
                let id = "t\(counter)"
                live[k] = (bank, index, id)
                let vel = 0.86 + Double.random(in: 0...0.08)
                app.js("BP.pad(\(bank),\(index),\(String(format: "%.3f", vel)),'\(id)')")
            }
        }
        for t in touches where t.phase == .ended || t.phase == .cancelled {
            if let hit = live.removeValue(forKey: key(t)) {
                app.js("BP.padUp(\(hit.bank),\(hit.index),'\(hit.id)')")
            }
        }
        guard captured else { return }
        let now = event.timestamp
        let active = touches.filter { $0.phase != .ended && $0.phase != .cancelled }
        if now - lastDots > 1.0 / 60 || active.isEmpty {
            lastDots = now
            let list = active.map { t -> String in
                let p = t.normalizedPosition
                return "{id:'\(ObjectIdentifier(t.identity as AnyObject).hashValue)',x:\(String(format: "%.4f", p.x)),y:\(String(format: "%.4f", p.y))}"
            }
            app.js("BP.touches([\(list.joined(separator: ","))])")
        }
    }

    func releaseAll() {
        guard let app else { return }
        for hit in live.values { app.js("BP.padUp(\(hit.bank),\(hit.index),'\(hit.id)')") }
        live.removeAll()
        app.js("BP.touches([])")
    }
}
