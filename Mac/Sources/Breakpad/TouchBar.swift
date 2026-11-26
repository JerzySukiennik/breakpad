// Breakpad for Mac: Touch Bar with play, kit switcher, eight multi-touch FX pads, drop and a hold-to-roll key.
import AppKit

extension NSTouchBarItem.Identifier {
    static let bpPlay = NSTouchBarItem.Identifier("fun.gzowo.breakpad.play")
    static let bpKit = NSTouchBarItem.Identifier("fun.gzowo.breakpad.kit")
    static let bpPads = NSTouchBarItem.Identifier("fun.gzowo.breakpad.pads")
    static let bpDrop = NSTouchBarItem.Identifier("fun.gzowo.breakpad.drop")
    static let bpRoll = NSTouchBarItem.Identifier("fun.gzowo.breakpad.roll")
}

final class BarPads: NSView {
    var labels: [String] = [] { didSet { needsDisplay = true } }
    var accent = NSColor.white { didSet { needsDisplay = true } }
    var onDown: ((Int) -> Void)?
    var onUp: ((Int) -> Void)?
    private var fingers: [AnyHashable: Int] = [:]
    private var lit: [Int: Double] = [:]
    private var timer: Timer?

    override init(frame: NSRect) {
        super.init(frame: frame)
        allowedTouchTypes = [.direct]
    }

    required init?(coder: NSCoder) { nil }

    override var intrinsicContentSize: NSSize { NSSize(width: 336, height: 30) }

    private func index(_ x: CGFloat) -> Int { min(7, max(0, Int(x / bounds.width * 8))) }

    override func draw(_ dirtyRect: NSRect) {
        let w = bounds.width / 8
        let now = ProcessInfo.processInfo.systemUptime
        for i in 0..<8 {
            let r = NSRect(x: CGFloat(i) * w + 1.5, y: 0, width: w - 3, height: bounds.height)
            let held = fingers.values.contains(i)
            let fade = max(0, 1 - (now - (lit[i] ?? 0)) / 0.35)
            let base = NSColor(white: 0.2, alpha: 1)
            let fill = held ? accent : base.blended(withFraction: CGFloat(fade), of: accent) ?? base
            fill.setFill()
            NSBezierPath(roundedRect: r, xRadius: 6, yRadius: 6).fill()
            let title = i < labels.count ? labels[i] : ""
            let on = held || fade > 0.5
            let text = NSAttributedString(string: title, attributes: [.font: NSFont.systemFont(ofSize: 9.5, weight: .semibold), .foregroundColor: on ? NSColor.black : NSColor(white: 0.9, alpha: 1)])
            let size = text.size()
            let clip = min(size.width, r.width - 6)
            text.draw(in: NSRect(x: r.midX - clip / 2, y: (bounds.height - size.height) / 2, width: clip, height: size.height))
        }
    }

    private func animate() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] t in
            guard let self else { t.invalidate(); return }
            self.needsDisplay = true
            let now = ProcessInfo.processInfo.systemUptime
            if self.fingers.isEmpty, self.lit.values.allSatisfy({ now - $0 > 0.4 }) {
                t.invalidate()
                self.timer = nil
            }
        }
    }

    override func touchesBegan(with event: NSEvent) {
        for t in event.touches(matching: .began, in: self) {
            let i = index(t.location(in: self).x)
            fingers[AnyHashable(t.identity as! NSObject)] = i
            lit[i] = ProcessInfo.processInfo.systemUptime
            onDown?(i)
        }
        animate()
        needsDisplay = true
    }

    override func touchesEnded(with event: NSEvent) { release(event) }
    override func touchesCancelled(with event: NSEvent) { release(event) }

    private func release(_ event: NSEvent) {
        for t in event.touches(matching: [.ended, .cancelled], in: self) {
            if let i = fingers.removeValue(forKey: AnyHashable(t.identity as! NSObject)) { onUp?(i) }
        }
        needsDisplay = true
    }
}

final class HoldKey: NSView {
    var title = "ROLL" { didSet { needsDisplay = true } }
    var lit = false { didSet { needsDisplay = true } }
    var accent = NSColor.white { didSet { needsDisplay = true } }
    var onDown: (() -> Void)?
    var onUp: (() -> Void)?
    private var finger: AnyHashable?

    override init(frame: NSRect) {
        super.init(frame: frame)
        allowedTouchTypes = [.direct]
    }

    required init?(coder: NSCoder) { nil }

    override var intrinsicContentSize: NSSize { NSSize(width: 60, height: 30) }

    override func draw(_ dirtyRect: NSRect) {
        (lit ? accent : NSColor(white: 0.2, alpha: 1)).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
        let text = NSAttributedString(string: title, attributes: [.font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: lit ? NSColor.black : NSColor.white])
        let s = text.size()
        text.draw(at: NSPoint(x: (bounds.width - s.width) / 2, y: (bounds.height - s.height) / 2))
    }

    override func touchesBegan(with event: NSEvent) {
        guard finger == nil, let t = event.touches(matching: .began, in: self).first else { return }
        finger = AnyHashable(t.identity as! NSObject)
        lit = true
        onDown?()
    }

    override func touchesEnded(with event: NSEvent) { release(event) }
    override func touchesCancelled(with event: NSEvent) { release(event) }

    private func release(_ event: NSEvent) {
        guard let finger, event.touches(matching: [.ended, .cancelled], in: self).contains(where: { AnyHashable($0.identity as! NSObject) == finger }) else { return }
        self.finger = nil
        lit = false
        onUp?()
    }
}

final class PadBar: NSObject, NSTouchBarDelegate {
    unowned let app: AppDelegate
    private let play = NSButton(title: "", target: nil, action: nil)
    private let kitLabel = NSTextField(labelWithString: "Liquid")
    private let pads = BarPads()
    private let drop = NSButton(title: "Breakdown", target: nil, action: nil)
    private let roll = HoldKey()

    init(app: AppDelegate) {
        self.app = app
        super.init()
        play.target = self
        play.action = #selector(tapPlay)
        play.bezelColor = NSColor(white: 0.2, alpha: 1)
        drop.target = self
        drop.action = #selector(tapDrop)
        kitLabel.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        kitLabel.alignment = .center
        kitLabel.lineBreakMode = .byTruncatingTail
        kitLabel.widthAnchor.constraint(equalToConstant: 92).isActive = true
        pads.onDown = { [weak self] i in self?.app.js("BP.cmd('fxDown',\(i))") }
        pads.onUp = { [weak self] i in self?.app.js("BP.cmd('fxUp',\(i))") }
        roll.onDown = { [weak self] in self?.app.js("BP.cmd('roll',1)") }
        roll.onUp = { [weak self] in self?.app.js("BP.cmd('rollEnd')") }
        refresh()
    }

    func make() -> NSTouchBar {
        let bar = NSTouchBar()
        bar.delegate = self
        bar.defaultItemIdentifiers = [.bpPlay, .bpKit, .bpPads, .bpDrop, .bpRoll]
        return bar
    }

    func touchBar(_ touchBar: NSTouchBar, makeItemForIdentifier identifier: NSTouchBarItem.Identifier) -> NSTouchBarItem? {
        let item = NSCustomTouchBarItem(identifier: identifier)
        switch identifier {
        case .bpPlay:
            play.widthAnchor.constraint(equalToConstant: 44).isActive = true
            item.view = play
        case .bpKit:
            let prev = NSButton(image: NSImage(systemSymbolName: "chevron.left", accessibilityDescription: "Poprzedni")!, target: self, action: #selector(prevKit))
            let next = NSButton(image: NSImage(systemSymbolName: "chevron.right", accessibilityDescription: "Następny")!, target: self, action: #selector(nextKit))
            prev.widthAnchor.constraint(equalToConstant: 30).isActive = true
            next.widthAnchor.constraint(equalToConstant: 30).isActive = true
            let stack = NSStackView(views: [prev, kitLabel, next])
            stack.spacing = 2
            item.view = stack
        case .bpPads:
            item.view = pads
        case .bpDrop:
            drop.widthAnchor.constraint(equalToConstant: 80).isActive = true
            item.view = drop
        case .bpRoll:
            item.view = roll
        default:
            return nil
        }
        return item
    }

    func refresh() {
        let s = app.state
        play.image = NSImage(systemSymbolName: s.playing ? "stop.fill" : "play.fill", accessibilityDescription: s.playing ? "Stop" : "Start")
        play.bezelColor = s.playing ? s.accent.withAlphaComponent(0.85) : NSColor(white: 0.2, alpha: 1)
        kitLabel.stringValue = s.kit
        kitLabel.textColor = s.accent
        pads.labels = s.fx.map { $0 == "BREAK" ? "BREAK" : $0 }
        pads.accent = s.accent
        let target = s.pending ?? (s.section == "break" ? "drop" : "break")
        drop.title = s.pending != nil ? (target == "break" ? "Breakdown…" : "Drop…") : (s.section == "break" ? "Drop" : "Breakdown")
        drop.bezelColor = s.section == "break" ? s.accent.withAlphaComponent(0.85) : NSColor(white: 0.2, alpha: 1)
        roll.accent = s.accent
        roll.title = s.roll == 0.5 ? "1/32" : "ROLL"
    }

    @objc func tapPlay() { app.js("BP.cmd('play')") }
    @objc func tapDrop() { app.js("BP.cmd('drop')") }
    @objc func prevKit() { app.js("BP.cmd('kitPrev')") }
    @objc func nextKit() { app.js("BP.cmd('kitNext')") }
}
