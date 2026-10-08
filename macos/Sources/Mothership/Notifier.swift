import AppKit
import UserNotifications

// A notification when a chat replies while the app isn't in front (in front,
// the page's own notice does it), and the unread count on the Dock icon.
// Unread is the server's: a turn ended after the chat was last seen anywhere.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
  var onOpen: ((String) -> Void)?
  private(set) var posted: [(id: String, title: String, body: String)] = [] // for the self-test
  private var known: [String: (unread: Bool, doneAt: Double)] = [:]
  private var primed = false // the first list after launch is the baseline, not news

  func setUp(askPermission: Bool) {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    if askPermission { center.requestAuthorization(options: [.alert, .sound]) { _, _ in } }
  }

  func update(_ chats: [[String: Any]], quiet: Bool) {
    var unread = 0
    for chat in chats {
      guard let id = chat["id"] as? String else { continue }
      let isUnread = chat["unread"] as? Bool ?? false
      let doneAt = (chat["doneAt"] as? NSNumber)?.doubleValue ?? 0
      if isUnread { unread += 1 }
      let before = known[id]
      let news = isUnread && (before == nil || before!.unread == false || before!.doneAt != doneAt)
      if primed && news && !quiet { post(chat, id: id) }
      known[id] = (isUnread, doneAt)
    }
    primed = true
    NSApp.dockTile.badgeLabel = unread > 0 ? "\(unread)" : nil
  }

  private func post(_ chat: [String: Any], id: String) {
    let content = UNMutableNotificationContent()
    content.title = (chat["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "New chat"
    content.body = (chat["preview"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "New reply"
    content.sound = .default
    content.threadIdentifier = id
    content.userInfo = ["chatId": id]
    posted.append((id, content.title, content.body))
    // One per chat: a newer reply replaces the older notification.
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
    if let id = response.notification.request.content.userInfo["chatId"] as? String {
      DispatchQueue.main.async { self.onOpen?(id) }
    }
    done()
  }

  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
    done([.banner, .sound])
  }
}
