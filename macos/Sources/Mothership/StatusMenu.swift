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

  // The app icon's flying wing as a template, drawn in the icon's 1024 grid
  // (macos/AppIcon.svg): the whole wing, then its left half again in shade
  // (lighter in a template), so the ridge down the middle still reads.
  private static func glyph() -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
      guard let cg = NSGraphicsContext.current?.cgContext else { return false }
      cg.scaleBy(x: 18 / 820, y: 18 / 820)
      cg.translateBy(x: -102, y: -102)
      let polygon = { (points: [(CGFloat, CGFloat)]) in
        let path = NSBezierPath()
        path.move(to: NSPoint(x: points[0].0, y: points[0].1))
        for (x, y) in points.dropFirst() { path.line(to: NSPoint(x: x, y: y)) }
        path.close()
        return path
      }
      let left: [(CGFloat, CGFloat)] = [(512, 330), (512, 695), (376, 607), (248, 690), (128, 612), (112, 590)]
      let right: [(CGFloat, CGFloat)] = [(512, 330), (912, 590), (896, 612), (776, 690), (648, 607), (512, 695)]
      NSColor.black.set()
      polygon(right).fill()
      NSColor.black.withAlphaComponent(0.55).set()
      polygon(left).fill()
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
