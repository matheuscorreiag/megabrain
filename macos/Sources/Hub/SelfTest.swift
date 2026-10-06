#if DEBUG
  import AppKit
  import WebKit

  // Debug builds only: `Hub -selfTest <dir> -localPort <test server's port>`
  // drives the app against a test server — real key events through AppKit,
  // the menu-bar switch, the native dialogs, the chat feed — and writes
  // results.txt plus snapshots of what the window shows. Never production.
  final class SelfTest {
    private let app: AppDelegate
    private let out: URL
    private var lines: [String] = []
    private var web: WebWindow { app.web }

    init(app: AppDelegate, out: URL) {
      self.app = app
      self.out = out
    }

    func run() {
      guard Prefs.serverURL.port != 7680 else {
        print("self-test: refusing to run against port 7680 (production); pass -localPort")
        exit(2)
      }
      try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
      Task { @MainActor in
        await steps()
        try? lines.joined(separator: "\n").write(to: out.appending(path: "results.txt"), atomically: true, encoding: .utf8)
        NSApp.terminate(nil)
      }
    }

    private func check(_ name: String, _ ok: Bool, _ detail: Any? = nil) {
      let line = "\(ok ? "PASS" : "FAIL")  \(name)" + (detail.map { "  (\($0))" } ?? "")
      lines.append(line)
      print(line)
    }

    @discardableResult
    @MainActor private func js(_ code: String) async -> Any? {
      try? await web.webView.evaluateJavaScript(code)
    }

    private func wait(_ seconds: Double) async {
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }

    @MainActor private func until(_ seconds: Double, _ test: () async -> Bool) async -> Bool {
      for _ in 0..<Int(seconds * 10) {
        if await test() { return true }
        await wait(0.1)
      }
      return await test()
    }

    // A real ⌘-key event, offered the way AppKit does: the focused view first
    // (WKWebView passes it to the page), then the menus.
    @MainActor private func press(_ chars: String, _ keyCode: UInt16) {
      let event = NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: web.window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars,
        isARepeat: false, keyCode: keyCode)!
      if !web.webView.performKeyEquivalent(with: event) { _ = NSApp.mainMenu?.performKeyEquivalent(with: event) }
    }

    @MainActor private func snapshot(_ name: String) async {
      guard let image = try? await web.webView.takeSnapshot(configuration: nil) else { return check("snapshot \(name)", false) }
      save(image, name)
    }

    private func save(_ image: NSImage, _ name: String) {
      guard let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
      try? png.write(to: out.appending(path: "\(name).png"))
    }

    @MainActor private func text(_ code: String) async -> String { await js(code) as? String ?? "" }
    @MainActor private func flag(_ code: String) async -> Bool { await js(code) as? Bool ?? false }

    @MainActor private func steps() async {
      web.autoConfirm = true
      web.window.makeFirstResponder(web.webView)

      // The page, its socket, and knowing it runs in the app.
      let online = await until(8) { await self.text("document.querySelector('#conn')?.dataset.state") == "online" }
      check("page loads and connects", online)
      check("page knows it runs in the app (⌘N hint)", await text("document.querySelector('#new-chat-hint')?.textContent") == "⌘N")
      let firstChat = await text("location.hash.slice(1)")
      await snapshot("window")
      check("window title follows the page", web.window.title == web.webView.title && !web.window.title.isEmpty, web.window.title)

      // The chat feed (its own socket) and the badge.
      check("feed receives the chat list", await until(5) { self.app.chatCount > 0 }, app.chatCount)

      // Shortcuts, as real key events.
      await js("document.activeElement?.blur()")
      press("k", 40)
      check("⌘K focuses the message box", await until(1) { await self.text("document.activeElement?.id") == "input" })
      let collapsed = await flag("document.body.classList.contains('sidebar-collapsed')")
      press("b", 11)
      await wait(0.5)
      check("⌘B toggles the sidebar exactly once", await flag("document.body.classList.contains('sidebar-collapsed')") != collapsed)
      press("b", 11)
      await wait(0.4)
      press("/", 44)
      check("⌘/ opens Shortcuts", await until(1) { await self.text("location.hash") == "#shortcuts" })
      press("1", 18)
      let first = (try? await web.webView.callAsyncJavaScript("return (await (await fetch('/api/chats')).json())[0]?.id || ''", contentWorld: .page)) as? String ?? ""
      check("⌘1 opens the first chat", await until(1.5) { await self.text("location.hash.slice(1)") == first && !first.isEmpty }, first)
      press("n", 45)
      check("⌘N starts a new chat", await until(1.5) { await self.text("location.hash") == "" })

      // The menu path on its own: what a shortcut does when the page isn't focused.
      let before = await flag("document.body.classList.contains('sidebar-collapsed')")
      let viewMenu = NSApp.mainMenu?.item(withTitle: "View")?.submenu
      if let toggle = viewMenu?.item(withTitle: "Show / Hide Sidebar"), let index = viewMenu?.index(of: toggle) {
        viewMenu?.performActionForItem(at: index)
      }
      await wait(0.5)
      check("View ▸ Show / Hide Sidebar reaches the page", await flag("document.body.classList.contains('sidebar-collapsed')") != before)
      viewMenu.flatMap { menu in menu.item(withTitle: "Show / Hide Sidebar").map { menu.performActionForItem(at: menu.index(of: $0)) } }
      await wait(0.4)
      if !firstChat.isEmpty { web.open(chat: firstChat) }

      // Notifications: news only after the baseline, only for newly unread chats.
      let notifier = Notifier()
      notifier.update([["id": "a", "title": "A", "unread": false, "doneAt": 1]], quiet: false)
      notifier.update([["id": "a", "title": "A", "unread": true, "doneAt": 2, "preview": "Done: 3 files"]], quiet: false)
      notifier.update([["id": "a", "title": "A", "unread": true, "doneAt": 2, "preview": "Done: 3 files"]], quiet: false)
      check("a newly unread chat posts one notification", notifier.posted.count == 1 && notifier.posted.first?.body == "Done: 3 files", notifier.posted.count)
      check("Dock badge shows the unread count", NSApp.dockTile.badgeLabel == "1", NSApp.dockTile.badgeLabel ?? "nil")
      notifier.update([["id": "a", "title": "A", "unread": true, "doneAt": 3]], quiet: true)
      check("no notification while the app is in front", notifier.posted.count == 1)
      notifier.update([["id": "a", "title": "A", "unread": false, "doneAt": 3]], quiet: false)
      check("badge clears when read", NSApp.dockTile.badgeLabel == nil)

      // The menu-bar switch.
      await withCheckedContinuation { done in Server.shared.refresh { done.resume() } }
      check("menu bar sees the server on, on this Mac", Server.shared.status.reachable && Server.shared.status.on && Server.shared.status.thisMac)
      app.turnOff(nil)
      check("Turn Off turns the server off", await until(3) { Server.shared.status.reachable && !Server.shared.status.on })
      check("the page shows Turned off", await until(3) { await self.flag("!document.querySelector('#off-screen').hidden") })
      check("…with Turn on (this Mac)", await flag("!document.querySelector('#turn-on').hidden"))
      await snapshot("off")
      app.turnOn(nil)
      check("Turn On turns it back on", await until(3) { Server.shared.status.on })
      check("…and the page comes back", await until(5) { await self.text("document.querySelector('#conn')?.dataset.state") == "online" })

      // The page's own switch, through the native confirm.
      await js("document.querySelector('#turn-off').click()")
      let off = await until(3) { await self.flag("!document.querySelector('#off-screen').hidden") }
      check("page Turn off goes through the native confirm", off && (web.lastConfirm ?? "").hasPrefix("Turn off?"), web.lastConfirm ?? "no dialog")
      await js("document.querySelector('#turn-on').click()")
      check("page Turn on brings it back", await until(5) { await self.text("document.querySelector('#conn')?.dataset.state") == "online" })
      await withCheckedContinuation { done in Server.shared.refresh { done.resume() } }
      check("menu bar follows the page's switch", Server.shared.status.on)

      // Terminal page: ⌘E is the Files panel.
      web.load(path: "/terminal/")
      _ = await until(5) {
        let path = await self.text("location.pathname")
        let ready = await self.text("document.readyState")
        return path == "/terminal/" && ready == "complete"
      }
      await wait(1)
      let files = await flag("document.body.classList.contains('files-open')")
      press("e", 14)
      check("⌘E toggles Files on the terminal page", await until(1.5) { await self.flag("document.body.classList.contains('files-open')") != files })
      press("e", 14)
      await snapshot("terminal")

      // Nothing listening: the native "Not running" page.
      Prefs.testServerURL = URL(string: "http://127.0.0.1:7699")
      web.load()
      // This Mac's server can be started; on a Mac without one (-launchdLabel <none>), point at another.
      let expected = Server.shared.hasService ? "not running" : "no server on this mac"
      let shown = await until(5) { (await self.text("document.body?.innerText || ''")).lowercased().contains(expected) }
      check("unreachable server shows the native page (\(expected))", shown, shown ? nil : "url \(web.webView.url?.absoluteString ?? "nil"), text \(await text("document.body?.innerText || ''").prefix(80))")
      await snapshot(Server.shared.hasService ? "unreachable" : "no-server")
      if !Server.shared.hasService {
        await js("document.querySelector('button').click()")
        check("Connect to Another Mac… opens Settings", await until(2) { self.app.settingsWindow.isVisible })
        app.settingsWindow.orderOut(nil)
      }
      Prefs.testServerURL = nil
      web.load()
      _ = await until(5) { await self.text("document.querySelector('#conn')?.dataset.state") == "online" }

      // The Settings window, as drawn.
      app.showSettings(nil)
      await wait(0.5)
      if let view = app.settingsWindow.contentView {
        // Cached drawings come out on white; the window's dark background is the window's, not the view's.
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor(srgbRed: 0.17, green: 0.17, blue: 0.18, alpha: 1).cgColor
        if let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
          view.cacheDisplay(in: view.bounds, to: rep)
          let image = NSImage(size: view.bounds.size)
          image.addRepresentation(rep)
          save(image, "settings")
        }
        view.layer?.backgroundColor = nil
      }
      check("Settings opens", app.settingsWindow.isVisible)
      app.settingsWindow.orderOut(nil)

      // Open at login (registers this debug build for a moment, then removes it).
      let wasOn = LoginItem.enabled
      do {
        try LoginItem.set(true)
        let registered = LoginItem.enabled
        try LoginItem.set(wasOn)
        check("Open at login registers and unregisters", registered && LoginItem.enabled == wasOn)
      } catch {
        check("Open at login registers and unregisters", false, error.localizedDescription)
      }

      // Menu-bar icon, as drawn.
      if let image = app.statusImage() { save(image, "status-item") }
    }
  }
#endif
