import AppKit

// Which server the app shows: this Mac's, or another Mac's over Tailscale.
final class SettingsWindow: NSObject, NSWindowDelegate {
  let window: NSWindow
  var onSave: (() -> Void)?
  private let thisMac = NSButton(radioButtonWithTitle: "This Mac", target: nil, action: nil)
  private let otherMac = NSButton(radioButtonWithTitle: "Another Mac:", target: nil, action: nil)
  private let address = NSTextField(string: "")
  private let loginItem = NSButton(checkboxWithTitle: "Open at login", target: nil, action: nil)

  override init() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 460, height: 10), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    super.init()
    window.title = "Settings"
    window.isReleasedWhenClosed = false
    window.delegate = self

    for radio in [thisMac, otherMac] {
      radio.target = self
      radio.action = #selector(pick(_:))
    }
    address.placeholderString = "https://your-mac.your-tailnet.ts.net"
    address.target = self
    address.action = #selector(save(_:))

    let heading = NSTextField(labelWithString: "Server")
    heading.font = .boldSystemFont(ofSize: NSFont.systemFontSize)
    let local = Self.note(Prefs.localURL.absoluteString)
    let hint = Self.note("The other Mac runs the server. This Mac needs Tailscale, signed in with a login it allows.")
    let other = NSStackView(views: [otherMac, address])
    other.spacing = 8
    let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancel(_:)))
    cancel.keyEquivalent = "\u{1b}"
    let save = NSButton(title: "Save", target: self, action: #selector(save(_:)))
    save.keyEquivalent = "\r"
    let buttons = NSStackView(views: [NSView(), cancel, save])

    let stack = NSStackView(views: [heading, thisMac, local, other, hint, loginItem, buttons])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    stack.setCustomSpacing(18, after: hint)
    stack.setCustomSpacing(20, after: loginItem)
    for view in [local, hint] { view.leadingAnchor.constraint(equalTo: stack.leadingAnchor, constant: 40).isActive = true }
    other.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true
    buttons.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true
    hint.widthAnchor.constraint(lessThanOrEqualToConstant: 380).isActive = true
    window.contentView = stack
  }

  func show() {
    thisMac.state = Prefs.isLocal ? .on : .off
    otherMac.state = Prefs.isLocal ? .off : .on
    address.stringValue = Prefs.remoteURL
    loginItem.state = LoginItem.enabled ? .on : .off
    address.isEnabled = otherMac.state == .on
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  @objc private func pick(_ sender: NSButton) {
    thisMac.state = sender == thisMac ? .on : .off
    otherMac.state = sender == otherMac ? .on : .off
    address.isEnabled = otherMac.state == .on
    if address.isEnabled { window.makeFirstResponder(address) }
  }

  @objc private func save(_ sender: Any?) {
    let remote = otherMac.state == .on
    if remote && Prefs.normalized(address.stringValue) == nil {
      let alert = NSAlert()
      alert.messageText = "That doesn't look like a server address."
      alert.informativeText = "Use the other Mac's Tailscale URL, like https://your-mac.your-tailnet.ts.net"
      alert.beginSheetModal(for: window)
      return
    }
    Prefs.useRemote = remote
    if remote { Prefs.remoteURL = Prefs.normalized(address.stringValue)!.absoluteString }
    if (loginItem.state == .on) != LoginItem.enabled {
      do { try LoginItem.set(loginItem.state == .on) } catch { NSAlert(error: error).runModal() }
    }
    window.orderOut(nil)
    onSave?()
  }

  @objc private func cancel(_ sender: Any?) {
    window.orderOut(nil)
  }

  private static func note(_ text: String) -> NSTextField {
    let label = NSTextField(wrappingLabelWithString: text)
    label.textColor = .secondaryLabelColor
    label.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    return label
  }
}
