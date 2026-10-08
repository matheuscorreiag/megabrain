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

// What you type is prompts, code and commands: WebKit must not rewrite it —
// no spelling correction, smart quotes or dashes (`--flag` → `—flag`), text
// replacements or red underlines. WebKit reads these from the app's defaults
// (registered, so they stay overridable per launch, e.g. by the self-test).
UserDefaults.standard.register(defaults: [
  "WebAutomaticSpellingCorrectionEnabled": false,
  "WebAutomaticQuoteSubstitutionEnabled": false,
  "WebAutomaticDashSubstitutionEnabled": false,
  "WebAutomaticTextReplacementEnabled": false,
  "WebContinuousSpellCheckingEnabled": false,
  "WebGrammarCheckingEnabled": false,
])

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
