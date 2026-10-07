import AppKit
import ServiceManagement

// The menu-bar item: whether the server is on, and the switch for it (only
// for the server on this Mac — the server enforces that too). The icon dims
// while it's off or unreachable.
final class StatusMenu: NSObject, NSMenuDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
  private let menu = NSMenu()
  private unowned let app: AppDelegate

  init(app: AppDelegate) {
    self.app = app
    super.init()
    item.button?.image = Self.glyph()
    menu.autoenablesItems = false
    menu.delegate = self
    item.menu = menu
    render(Server.shared.status)
  }

  func menuWillOpen(_ menu: NSMenu) {
    Server.shared.refresh() // re-renders the open menu when it answers
  }

  func render(_ status: ServerStatus) {
    item.button?.appearsDisabled = !(status.reachable && status.on)
    menu.removeAllItems()

    let place = Prefs.isLocal ? "This Mac" : Prefs.serverURL.host ?? ""
    let (state, color): (String, NSColor) =
      !status.reachable ? (!Prefs.isLocal ? "Can't reach it" : Server.shared.hasService ? "Not running" : "No server here", .systemRed)
      : status.on ? ("On", .systemGreen) : ("Turned off", .secondaryLabelColor)
    let header = NSMenuItem()
    let title = NSMutableAttributedString(string: "● ", attributes: [.foregroundColor: color])
    title.append(NSAttributedString(string: "\(state) — \(place)", attributes: [.font: NSFont.menuFont(ofSize: 0)]))
    header.attributedTitle = title
    header.isEnabled = false
    menu.addItem(header)
    menu.addItem(.separator())

    add("Open Window", #selector(AppDelegate.showWindow(_:)))
    if status.reachable && status.thisMac {
      add(status.on ? "Turn Off" : "Turn On", status.on ? #selector(AppDelegate.turnOff(_:)) : #selector(AppDelegate.turnOn(_:)))
    }
    if !status.reachable && Prefs.isLocal && Server.shared.hasService { add("Start Server", #selector(AppDelegate.startServer(_:))) }
    menu.addItem(.separator())
    add("Settings…", #selector(AppDelegate.showSettings(_:)))
    add("Open at Login", #selector(AppDelegate.toggleLoginItem(_:))).state = LoginItem.enabled ? .on : .off
    menu.addItem(.separator())
    add("Quit", #selector(NSApplication.terminate(_:)), target: NSApp)
  }

  // The app icon's mark — two bars and the hub between them — as a template.
  private static func glyph() -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
      NSColor.black.setFill()
      for x in [3.0, 12.0] {
        NSBezierPath(roundedRect: NSRect(x: x, y: 3, width: 3, height: 12), xRadius: 1.5, yRadius: 1.5).fill()
      }
      NSBezierPath(ovalIn: NSRect(x: 6.9, y: 6.9, width: 4.2, height: 4.2)).fill()
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "Server"
    return image
  }

  @discardableResult
  private func add(_ title: String, _ action: Selector, target: AnyObject? = nil) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
    item.target = target ?? app
    menu.addItem(item)
    return item
  }
}

enum LoginItem {
  static var enabled: Bool { SMAppService.mainApp.status == .enabled }

  static func set(_ on: Bool) throws {
    if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
  }
}
