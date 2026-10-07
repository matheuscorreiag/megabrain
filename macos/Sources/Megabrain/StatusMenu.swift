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

  // The app icon's mark — the brain's two halves and the core between them —
  // as a template, drawn in the icon's 1024 grid (macos/AppIcon.svg). Fewer
  // and thicker grooves than the icon, so they survive 18pt; the grooves and
  // the ring around the core are cut out.
  private static func glyph() -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: true) { _ in
      guard let cg = NSGraphicsContext.current?.cgContext else { return false }
      cg.scaleBy(x: 18 / 600, y: 18 / 600)
      cg.translateBy(x: -212, y: -212)
      NSColor.black.set()
      for mirrored in [false, true] {
        cg.saveGState()
        if mirrored {
          cg.translateBy(x: 1024, y: 0)
          cg.scaleBy(x: -1, y: 1)
        }
        let half = NSBezierPath()
        half.move(to: NSPoint(x: 500, y: 268))
        for (x, y, r) in [(392.0, 284.0, 62.0), (300, 368, 70), (270, 490, 70), (290, 614, 70), (360, 718, 70), (500, 756, 84)] {
          bulge(half, to: NSPoint(x: x, y: y), radius: r)
        }
        half.close()
        half.fill()
        cg.setBlendMode(.clear)
        let grooves = NSBezierPath()
        grooves.lineWidth = 40
        grooves.lineCapStyle = .round
        grooves.move(to: NSPoint(x: 416, y: 290))
        grooves.curve(to: NSPoint(x: 446, y: 392), controlPoint1: NSPoint(x: 396, y: 330), controlPoint2: NSPoint(x: 404, y: 372))
        grooves.move(to: NSPoint(x: 282, y: 452))
        grooves.curve(to: NSPoint(x: 380, y: 392), controlPoint1: NSPoint(x: 330, y: 452), controlPoint2: NSPoint(x: 366, y: 430))
        grooves.move(to: NSPoint(x: 296, y: 636))
        grooves.curve(to: NSPoint(x: 402, y: 576), controlPoint1: NSPoint(x: 344, y: 640), controlPoint2: NSPoint(x: 384, y: 618))
        grooves.stroke()
        cg.restoreGState()
      }
      cg.setBlendMode(.clear)
      NSBezierPath(ovalIn: NSRect(x: 512 - 98, y: 512 - 98, width: 196, height: 196)).fill()
      cg.setBlendMode(.normal)
      NSBezierPath(ovalIn: NSRect(x: 512 - 58, y: 512 - 58, width: 116, height: 116)).fill()
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "Server"
    return image
  }

  // SVG's `A r r 0 0 0 x y` from the current point: an arc bulging outward
  // (the small one, counterclockwise on screen) — one lobe of the outline.
  private static func bulge(_ path: NSBezierPath, to end: NSPoint, radius r: CGFloat) {
    let start = path.currentPoint
    let hx = (start.x - end.x) / 2, hy = (start.y - end.y) / 2
    let half = (hx * hx + hy * hy).squareRoot()
    let k = max(r * r - half * half, 0).squareRoot() / half
    let center = NSPoint(x: (start.x + end.x) / 2 - k * hy, y: (start.y + end.y) / 2 + k * hx)
    let angle = { (p: NSPoint) in atan2(p.y - center.y, p.x - center.x) * 180 / .pi }
    path.appendArc(withCenter: center, radius: r, startAngle: angle(start), endAngle: angle(end), clockwise: true)
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
