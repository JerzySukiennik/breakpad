// Breakpad for Mac: window, bundled web app over a custom scheme, JS bridge, trackpad capture and keyboard routing.
import AppKit
import WebKit

final class AppScheme: NSObject, WKURLSchemeHandler {
    let root: URL

    init(root: URL) { self.root = root }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path), let data = try? Data(contentsOf: file) else {
            task.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!)
            task.didFinish()
            return
        }
        let types = ["html": "text/html", "js": "text/javascript", "css": "text/css", "json": "application/json", "svg": "image/svg+xml", "wav": "audio/wav", "mp3": "audio/mpeg", "png": "image/png"]
        let type = types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let headers = ["Content-Type": type, "Content-Length": "\(data.count)", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"]
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class PadWebView: WKWebView {
    var barMaker: (() -> NSTouchBar?)?
    override func makeTouchBar() -> NSTouchBar? { barMaker?() }
}

final class Container: NSView {
    override func keyDown(with event: NSEvent) {}
    override func keyUp(with event: NSEvent) {}
    override var acceptsFirstResponder: Bool { true }
}

final class PadWindow: NSWindow {
    override func noResponder(for eventSelector: Selector) {}
}

struct PadState {
    var kit = "Liquid"
    var accent = NSColor(srgbRed: 0.24, green: 0.9, blue: 0.69, alpha: 1)
    var playing = false
    var section = "drop"
    var pending: String?
    var roll = 0.0
    var fx: [String] = ["VOX", "VOX", "SCRATCH", "REWIND", "FX", "FX", "IMPACT", "BREAK"]
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var window: PadWindow!
    var web: PadWebView!
    let trackpad = TrackpadView()
    var keyMonitor: Any?
    var touchMonitor: Any?
    var state = PadState()
    var bar: PadBar!
    var captured = false
    var ready = false

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let root = Bundle.main.resourceURL!.appendingPathComponent("web")
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(AppScheme(root: root), forURLScheme: "breakpad")
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "breakpad")
        let boot = "document.documentElement.classList.add('native');addEventListener('error',e=>webkit.messageHandlers.breakpad.postMessage({type:'log',msg:String(e.message)+' '+(e.filename||'')+':'+(e.lineno||'')}));addEventListener('unhandledrejection',e=>webkit.messageHandlers.breakpad.postMessage({type:'log',msg:'rejection '+String(e.reason)}))"
        config.userContentController.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = PadWebView(frame: .zero, configuration: config)
        web.isInspectable = true
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        bar = PadBar(app: self)
        web.barMaker = { [weak self] in self?.bar.make() }

        let frame = NSRect(x: 0, y: 0, width: 1280, height: 840)
        window = PadWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Breakpad"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.backgroundColor = NSColor(srgbRed: 0.043, green: 0.043, blue: 0.047, alpha: 1)
        window.isOpaque = true
        window.minSize = NSSize(width: 880, height: 620)
        window.delegate = self
        window.setFrameAutosaveName("BreakpadMain")
        if !window.setFrameUsingName("BreakpadMain") { window.center() }

        let container = Container(frame: frame)
        container.wantsLayer = true
        container.layer?.backgroundColor = window.backgroundColor.cgColor
        web.frame = container.bounds
        web.autoresizingMask = [.width, .height]
        trackpad.frame = container.bounds
        trackpad.autoresizingMask = [.width, .height]
        trackpad.app = self
        container.addSubview(web)
        container.addSubview(trackpad)
        window.contentView = container
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(web)
        let page = ProcessInfo.processInfo.environment["BP_SNAPSHOT"] != nil ? "breakpad://app/index.html?silent" : "breakpad://app/index.html"
        web.load(URLRequest(url: URL(string: page)!))

        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
            guard let self else { return event }
            if event.modifierFlags.contains(.command) { return event }
            if event.keyCode == 48 {
                if !event.isARepeat { self.capture(!self.captured) }
                return nil
            }
            if event.keyCode == 53, self.captured {
                self.capture(false)
                return nil
            }
            return event
        }
        touchMonitor = NSEvent.addLocalMonitorForEvents(matching: [.gesture]) { [weak self] event in
            self?.trackpad.feed(event)
            return event
        }
        if let shot = ProcessInfo.processInfo.environment["BP_SNAPSHOT"] {
            window.orderBack(nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
                self?.js(ProcessInfo.processInfo.environment["BP_JS"] ?? "0")
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    self?.web.takeSnapshot(with: nil) { image, _ in
                        if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                            try? png.write(to: URL(fileURLWithPath: shot))
                        }
                        self?.web.evaluateJavaScript("JSON.stringify(BP.state())") { value, error in
                            NSLog("Breakpad state: %@ %@", (value as? String) ?? "-", error.map { "\($0)" } ?? "")
                            NSApp.terminate(nil)
                        }
                    }
                }
            }
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "O Breakpad", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Ukryj Breakpad", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Zakończ Breakpad", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "Widok")
        viewMenu.addItem(withTitle: "Touchpad jako pady", action: #selector(toggleCapture), keyEquivalent: "t")
        viewMenu.addItem(withTitle: "Przeładuj", action: #selector(reload), keyEquivalent: "r")
        let fs = viewMenu.addItem(withTitle: "Pełny ekran", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        viewMenu.addItem(withTitle: "Zamknij okno", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        viewItem.submenu = viewMenu
        NSApp.mainMenu = main
    }

    @objc func toggleCapture() { capture(!captured) }
    @objc func reload() { web.reload() }

    func js(_ code: String) {
        web.evaluateJavaScript(code, completionHandler: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            NSLog("Breakpad web ready")
        case "log":
            NSLog("Breakpad js: %@", (body["msg"] as? String) ?? "")
        case "capture":
            capture((body["on"] as? Bool) ?? !captured)
        case "state":
            if let kit = body["kit"] as? String { state.kit = kit }
            if let hex = body["accent"] as? String, let c = NSColor(hex: hex) { state.accent = c }
            state.playing = (body["playing"] as? Bool) ?? false
            state.section = (body["section"] as? String) ?? "drop"
            state.pending = body["pending"] as? String
            state.roll = (body["roll"] as? Double) ?? 0
            if let fx = body["fx"] as? [String], fx.count == 8 { state.fx = fx }
            bar.refresh()
        default:
            break
        }
    }

    func capture(_ on: Bool) {
        let want = on && NSApp.isActive && window.isKeyWindow
        if want == captured { return }
        captured = want
        trackpad.captured = want
        if want {
            centerCursor()
            CGAssociateMouseAndMouseCursorPosition(0)
            NSCursor.hide()
        } else {
            trackpad.releaseAll()
            CGAssociateMouseAndMouseCursorPosition(1)
            NSCursor.unhide()
        }
        window.makeFirstResponder(web)
        js("BP.capture(\(want))")
    }

    func centerCursor() {
        let f = window.frame
        let top = NSScreen.screens.first?.frame.height ?? f.maxY
        CGWarpMouseCursorPosition(CGPoint(x: f.midX, y: top - f.midY))
    }

    func settle() {
        guard captured else { return }
        CGAssociateMouseAndMouseCursorPosition(1)
        centerCursor()
        CGAssociateMouseAndMouseCursorPosition(0)
        trackpad.releaseAll()
        window.makeFirstResponder(web)
    }

    func windowDidEnterFullScreen(_ note: Notification) { settle() }
    func windowDidExitFullScreen(_ note: Notification) { settle() }
    func windowDidResize(_ note: Notification) { settle() }
    func windowDidResignKey(_ note: Notification) { capture(false) }
    func applicationDidResignActive(_ note: Notification) { capture(false) }
    func applicationWillTerminate(_ note: Notification) {
        if captured {
            CGAssociateMouseAndMouseCursorPosition(1)
            NSCursor.unhide()
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

extension NSColor {
    convenience init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = Int(s, radix: 16) else { return nil }
        self.init(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
