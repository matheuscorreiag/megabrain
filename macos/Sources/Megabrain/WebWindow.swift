import AppKit
import WebKit

// The panel's UI in a window. Closing it only hides it, so the page stays
// loaded and reopening is instant. Links out of the panel open in the default
// browser; the page's confirm()/prompt(), file pickers and downloads get the
// native panels a browser would show.
final class WebWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
  let window: NSWindow
  let webView: WKWebView
  var onPower: ((Bool) -> Void)?
  var onStart: (() -> Void)?
  var onSettings: (() -> Void)?
  var autoConfirm = false // self-test: answer confirm() with OK
  private(set) var lastConfirm: String?
  private var observers: [NSKeyValueObservation] = []
  private var downloads: [ObjectIdentifier: URL] = [:]
  private static let background = NSColor(srgbRed: 0.043, green: 0.067, blue: 0.078, alpha: 1) // the icon's

  override init() {
    let config = WKWebViewConfiguration()
    config.applicationNameForUserAgent = "Megabrain"
    config.allowsInlinePredictions = false // no gray word completions as you type (see main.swift)
    let frame = NSRect(x: 0, y: 0, width: 1280, height: 820)
    webView = WKWebView(frame: frame, configuration: config)
    window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    super.init()
    // The page checks for this handler to know it runs in the app (ui.js `native`).
    config.userContentController.add(self, name: "megabrain")
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.setValue(false, forKey: "drawsBackground") // no white flash before the page paints
    webView.underPageBackgroundColor = Self.background
    webView.pageZoom = UserDefaults.standard.object(forKey: "zoom") as? Double ?? 1
    // The title bar takes the page's tint (its theme-color follows the chat's hue).
    window.titlebarAppearsTransparent = true
    window.backgroundColor = Self.background
    window.contentView = webView
    window.minSize = NSSize(width: 420, height: 480)
    window.isReleasedWhenClosed = false
    window.tabbingMode = .disallowed
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("Main")
    // No title in the bar (the open chat is in the status line). It's still the
    // app's name for the Window menu, Mission Control and VoiceOver.
    window.title = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "Megabrain"
    window.titleVisibility = .hidden
    observers = [
      webView.observe(\.themeColor) { [weak self] view, _ in self?.window.backgroundColor = view.themeColor ?? Self.background },
    ]
  }

  // MARK: - Showing and navigating

  func load(path: String = "/") {
    webView.load(URLRequest(url: URL(string: path, relativeTo: Prefs.serverURL)!.absoluteURL))
  }

  func show() {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  func reload() {
    if let url = webView.url, isPanel(url) { webView.reload() } else { load() }
  }

  func open(chat id: String) {
    show()
    if let url = webView.url, isPanel(url), url.path == "/" {
      webView.evaluateJavaScript("location.hash = \(Self.jsString(id))")
    } else {
      load(path: "/#\(id)")
    }
  }

  // Menu shortcuts end up in the page, whose shortcut tables decide what they
  // do. With the page focused it gets ⌘-keys before the menus anyway; this
  // covers the rest (window hidden, focus in a native panel).
  func shortcut(code: String, key: String, control: Bool = false, shift: Bool = false) {
    show()
    let event = "new KeyboardEvent('keydown', { code: \(Self.jsString(code)), key: \(Self.jsString(key)), metaKey: true, ctrlKey: \(control), shiftKey: \(shift), bubbles: true, cancelable: true })"
    webView.evaluateJavaScript("document.dispatchEvent(\(event))")
  }

  func zoom(_ step: Int) {
    let levels: [Double] = [0.8, 0.9, 1, 1.1, 1.25, 1.5]
    let current = levels.firstIndex { $0 >= webView.pageZoom - 0.001 } ?? 2
    webView.pageZoom = step == 0 ? 1 : levels[max(0, min(levels.count - 1, current + step))]
    UserDefaults.standard.set(webView.pageZoom, forKey: "zoom")
  }

  private func isPanel(_ url: URL) -> Bool {
    let base = Prefs.serverURL
    return url.scheme == base.scheme && url.host == base.host && url.port == base.port
  }

  private static func jsString(_ text: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [text])
    return String(data: data, encoding: .utf8)!.dropFirst().dropLast().description
  }

  // MARK: - Window

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    window.orderOut(nil)
    return false
  }

  // MARK: - Messages from the page

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let op = body["op"] as? String else { return }
    switch op {
    case "power": onPower?(body["on"] as? Bool ?? true) // turned on or off from the page
    case "start": onStart?() // the "Not running" page
    case "settings": onSettings?() // the "No server on this Mac" page
    case "retry": Server.shared.refresh { if Server.shared.status.reachable { self.load() } }
    default: break
    }
  }

  // MARK: - Navigation

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload { return decisionHandler(.download) }
    guard let url = action.request.url, action.targetFrame?.isMainFrame == true else { return decisionHandler(.allow) }
    if isPanel(url) || url.scheme == "about" { return decisionHandler(.allow) }
    NSWorkspace.shared.open(url)
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
    let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    decisionHandler(response.canShowMIMEType && !disposition.hasPrefix("attachment") ? .allow : .download)
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if (error as NSError).code != NSURLErrorCancelled { showUnreachable() }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    load()
  }

  // The server didn't answer at all (not just "turned off", which the page
  // shows itself): this Mac's can be started from here; another Mac's can't;
  // and a Mac without one (a downloaded copy) needs pointing at the server.
  private func showUnreachable() {
    let (label, note, button, op): (String, String, String, String) =
      !Prefs.isLocal ? ("Can't reach the server", "\(Prefs.serverURL.host ?? "") doesn't answer — asleep, off, or not on this network.", "Try again", "retry")
      : Server.shared.hasService ? ("Not running", "The server on this Mac isn't running.", "Start", "start")
      : ("No server on this Mac", "Connect to the Mac that runs it, by its Tailscale address.", "Connect to Another Mac…", "settings")
    let html = """
      <!doctype html><meta charset="utf-8"><style>
      html { color-scheme: dark; background: #0b1114; }
      body { margin: 0; height: 100vh; display: grid; place-content: center; justify-items: center; gap: 12px;
        font: 14px -apple-system, sans-serif; color: #9aacae; text-align: center; }
      p { margin: 0; }
      .label { font: 500 10px ui-monospace, monospace; letter-spacing: 0.14em; text-transform: uppercase; color: #5f7375; }
      button { margin-top: 10px; padding: 10px 18px; border: 1px solid #00a8b8; border-radius: 8px; background: #0f2a2e;
        color: #e8f0f0; font: 500 14px -apple-system, sans-serif; cursor: pointer; }
      button:hover { background: #12383d; }
      </style>
      <p class="label">\(label)</p><p>\(note)</p>
      <button onclick="webkit.messageHandlers.megabrain.postMessage({ op: '\(op)' }); this.disabled = \(op != "settings")">\(button)</button>
      <script>setInterval(() => webkit.messageHandlers.megabrain.postMessage({ op: 'retry' }), 5000)</script>
      """
    webView.loadHTMLString(html, baseURL: nil)
  }

  // MARK: - Downloads (Files panel → Download)

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
    let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
    let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
    let stem = (name as NSString).deletingPathExtension
    let ext = (name as NSString).pathExtension
    var url = folder.appending(path: name)
    var n = 1
    while FileManager.default.fileExists(atPath: url.path) {
      n += 1
      url = folder.appending(path: ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
    }
    downloads[ObjectIdentifier(download)] = url
    completionHandler(url)
  }

  func downloadDidFinish(_ download: WKDownload) {
    // Bounces the Downloads stack in the Dock, like a browser download.
    if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) {
      DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: url.path)
    }
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    downloads.removeValue(forKey: ObjectIdentifier(download))
  }

  // MARK: - Page UI: new windows, dialogs, file pickers

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) } // target=_blank: the default browser
    return nil
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
    let alert = Self.alert(message)
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
    lastConfirm = message
    if autoConfirm { return completionHandler(true) }
    let alert = Self.alert(message)
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void) {
    let alert = Self.alert(prompt)
    let field = NSTextField(string: defaultText ?? "")
    field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
    alert.accessoryView = field
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = field
    alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
  }

  // "Delete "x"? Its history is removed…" reads better as a title and a detail.
  private static func alert(_ message: String) -> NSAlert {
    let alert = NSAlert()
    if let split = message.range(of: "? ") ?? message.range(of: "\n") {
      alert.messageText = String(message[..<split.lowerBound]) + (message[split].hasPrefix("?") ? "?" : "")
      alert.informativeText = message[split.upperBound...].trimmingCharacters(in: .whitespacesAndNewlines)
    } else {
      alert.messageText = message
    }
    return alert
  }
}
