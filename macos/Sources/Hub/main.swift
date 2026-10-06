// The macOS app: a native window around the panel's own web UI (served by
// server.js on this Mac, or on another one over Tailscale), plus what a
// browser tab can't do — every ⌘ shortcut, notifications and a Dock badge
// with the window closed, a menu-bar switch for the server, open at login.
//
//   AppDelegate.swift   wiring, menu actions, the main menu
//   WebWindow.swift     the window and its web view (dialogs, downloads, links)
//   StatusMenu.swift    the menu-bar item
//   Server.swift        settings, the server's API, the chat-list feed
//   Notifier.swift      notifications and the Dock badge
//   SettingsWindow.swift
//   SelfTest.swift      debug builds only

import AppKit

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
